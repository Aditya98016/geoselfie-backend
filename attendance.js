/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Period day bug fixed — sirf aaj ka day match hoga
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { isInsideGeofence, isCollegeTime, detectFakeGPS } = require('./geofence');
const { authMiddleware } = require('./middleware');

const router  = express.Router();
const todayDate = () => new Date().toISOString().split('T')[0];
const nowISO    = () => new Date().toISOString();

// Aaj ka day name — FIX 2 root cause yahan tha
function getTodayDayName() {
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  return days[new Date().getDay()];
}

// Current time in minutes
function getCurrentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// POST /api/attendance/ping
router.post('/ping', authMiddleware, (req, res) => {
  try {
    const { lat, lng, accuracy, speed, altitude, is_mock, period_number = 0 } = req.body;
    const studentId = req.user.id;

    if (!lat || !lng) return res.status(400).json({ error: 'Location required' });

    // Anti fake GPS
    const fakeCheck = detectFakeGPS(accuracy, speed, altitude);
    if (is_mock || fakeCheck.isFake) {
      dbRun(`INSERT INTO location_events
             (id, student_id, event_type, lat, lng, accuracy, is_mock, timestamp)
             VALUES (?, ?, 'fake_gps_attempt', ?, ?, ?, 1, ?)`,
        [uuidv4(), studentId, lat, lng, accuracy||0, nowISO()]);
      return res.json({
        inside: false, fakeGPS: true,
        reason: fakeCheck.reasons?.join(', ') || 'Mock GPS detected'
      });
    }

    const user      = dbGet('SELECT class_code FROM users WHERE id = ?', [studentId]);
    const classInfo = user ? dbGet('SELECT * FROM classes WHERE class_code = ?', [user.class_code]) : null;

    if (!classInfo || !classInfo.lat) {
      return res.json({ inside: false, distance: null, message: 'College location not set yet' });
    }

    const geo     = isInsideGeofence(parseFloat(lat), parseFloat(lng), classInfo.lat, classInfo.lng, classInfo.radius_meters||200);
    const time    = isCollegeTime(classInfo.start_time, classInfo.end_time, classInfo.lunch_start, classInfo.lunch_end);
    const date    = todayDate();

    // FIX 2: Aaj ka actual day name use karo
    const todayDay  = getTodayDayName();
    const curMin    = getCurrentMinutes();

    // Aaj ke periods mein se current period dhundho
    const todayPeriods = dbAll(
      'SELECT * FROM periods WHERE class_code = ? AND day = ? ORDER BY period_number',
      [user.class_code, todayDay]
    );

    const currentPeriod = todayPeriods.find(p =>
      curMin >= timeToMinutes(p.start_time) && curMin <= timeToMinutes(p.end_time)
    ) || { period_number: 0, subject: 'General', id: null };

    let session = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id = ? AND date = ? AND period_number = ?',
      [studentId, date, currentPeriod.period_number]
    );

    // attendance.js ping route mein yeh part replace karo
if (geo.inside && time.isOpen && !time.isLunch) {
  if (!session) {
    const sid = uuidv4();
    const entryTime = nowISO();
    dbRun(`INSERT INTO attendance_sessions
           (id,student_id,class_code,date,period_id,period_number,
            subject,entry_time,status,method,total_minutes)
           VALUES (?,?,?,?,?,?,?,?,'present','auto',0)`,
      [sid, studentId, user.class_code, date,
       currentPeriod.id, currentPeriod.period_number,
       currentPeriod.subject, entryTime]);
    session = dbGet('SELECT * FROM attendance_sessions WHERE id=?', [sid]);
  } else if (session.status === 'absent') {
    dbRun(`UPDATE attendance_sessions
           SET status='present', entry_time=?, exit_time=NULL, total_minutes=0
           WHERE id=?`, [nowISO(), session.id]);
    session = dbGet('SELECT * FROM attendance_sessions WHERE id=?', [session.id]);
  }

  // FIX: total_minutes calculate karo entry_time se
  if (session?.entry_time) {
    const entryMs  = new Date(session.entry_time).getTime();
    const nowMs    = Date.now();
    const diffMins = Math.max(0, Math.floor((nowMs - entryMs) / 60000));
    dbRun('UPDATE attendance_sessions SET total_minutes=? WHERE id=?',
      [diffMins, session.id]);
  }
}

    // 75% check
    const history = dbAll(
      'SELECT status FROM attendance_sessions WHERE student_id = ? ORDER BY date DESC LIMIT 30',
      [studentId]
    );
    const present = history.filter(h => h.status === 'present').length;
    const pct     = history.length ? Math.round((present / history.length) * 100) : 100;

    const allSessions = dbAll(
      'SELECT * FROM attendance_sessions WHERE student_id = ? AND date = ? ORDER BY period_number',
      [studentId, date]
    );

    res.json({
      inside: geo.inside, distance: geo.distance,
      isLunch: time.isLunch, isCollegeTime: time.isOpen,
      fakeGPS: false, warning75: pct < 75, attendancePct: pct,
      currentPeriod, todayDay, sessions: allSessions
    });
  } catch(e) {
    console.error('Ping error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/attendance/sync-offline
router.post('/sync-offline', authMiddleware, (req, res) => {
  try {
    const { records } = req.body;
    if (!records || !Array.isArray(records))
      return res.status(400).json({ error: 'Records array required' });
    let synced = 0;
    records.forEach(r => {
      const existing = dbGet('SELECT id FROM offline_queue WHERE id = ?', [r.id]);
      if (!existing) {
        dbRun('INSERT INTO offline_queue (id, student_id, lat, lng, timestamp, synced) VALUES (?, ?, ?, ?, ?, 1)',
          [r.id || uuidv4(), req.user.id, r.lat, r.lng, r.timestamp]);
        synced++;
      }
    });
    res.json({ message: `${synced} records synced`, synced });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/attendance/correction-request
router.post('/correction-request', authMiddleware, (req, res) => {
  try {
    const { session_date, period_number, subject, reason } = req.body;
    if (!session_date || !reason)
      return res.status(400).json({ error: 'Date and reason required' });

    const id = uuidv4();
    dbRun(`INSERT INTO correction_requests
           (id, student_id, session_date, period_number, subject, reason, status, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, req.user.id, session_date, period_number||0, subject||'General', reason, nowISO()]);

    res.json({ message: 'Correction request submitted!', id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance/correction-requests
router.get('/correction-requests', authMiddleware, (req, res) => {
  try {
    const requests = dbAll(`
      SELECT cr.*, u.name as student_name, u.roll_no
      FROM correction_requests cr
      JOIN users u ON u.id = cr.student_id
      WHERE u.class_code = ?
      ORDER BY cr.requested_at DESC
    `, [req.user.class_code]);
    res.json({ requests });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/attendance/correction-request/:id
router.put('/correction-request/:id', authMiddleware, (req, res) => {
  try {
    const { status, teacher_note } = req.body;
    dbRun(`UPDATE correction_requests SET status=?, teacher_note=?, resolved_at=? WHERE id=?`,
      [status, teacher_note||null, nowISO(), req.params.id]);

    if (status === 'approved') {
      const cr = dbGet('SELECT * FROM correction_requests WHERE id=?', [req.params.id]);
      if (cr) {
        const existing = dbGet(
          'SELECT id FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
          [cr.student_id, cr.session_date, cr.period_number||0]
        );
        if (existing) {
          dbRun(`UPDATE attendance_sessions SET status='present', method='corrected' WHERE id=?`, [existing.id]);
        } else {
          dbRun(`INSERT INTO attendance_sessions
                 (id, student_id, date, period_number, subject, status, method, created_at)
                 VALUES (?, ?, ?, ?, ?, 'present', 'corrected', ?)`,
            [uuidv4(), cr.student_id, cr.session_date, cr.period_number||0, cr.subject||'General', nowISO()]);
        }
      }
    }
    res.json({ message: `Request ${status}!` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance/today
router.get('/today', authMiddleware, (req, res) => {
  try {
    const date     = todayDate();
    const sessions = dbAll(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? ORDER BY period_number',
      [req.user.id, date]
    );
    const events   = dbAll(
      'SELECT * FROM location_events WHERE student_id=? AND date(timestamp)=? ORDER BY timestamp',
      [req.user.id, date]
    );
    const totalMin = sessions.reduce((s, ss) => s + (ss.total_minutes||0), 0);
    res.json({ sessions, events, percentage: Math.min(Math.round((totalMin/360)*100), 100), totalMinutes: totalMin });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance/history
router.get('/history', authMiddleware, (req, res) => {
  try {
    const history = dbAll(`
      SELECT date, period_number, subject, status, total_minutes, entry_time, exit_time, method
      FROM attendance_sessions
      WHERE student_id=?
      ORDER BY date DESC, period_number ASC
      LIMIT 90
    `, [req.user.id]);

    const grouped = {};
    history.forEach(h => {
      if (!grouped[h.date]) grouped[h.date] = [];
      grouped[h.date].push(h);
    });

    const present = history.filter(h => h.status === 'present').length;
    const pct     = history.length ? Math.round((present / history.length) * 100) : 0;

    res.json({
      history, grouped,
      analytics: {
        total: history.length, present,
        absent: history.length - present,
        percentage: pct, warning_75: pct < 75
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;