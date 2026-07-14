/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Geofence timer, attendance history, correction requests
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { isInsideGeofence, isCollegeTime, detectFakeGPS } = require('./geofence');
const { authMiddleware } = require('./middleware');

const router  = express.Router();
const todayDate = () => new Date().toISOString().split('T')[0];
const nowISO    = () => new Date().toISOString();

function getTodayDayName() {
  const now  = new Date();
  const ist  = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  return days[ist.getUTCDay()];
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = (t||'00:00').split(':').map(Number);
  return h * 60 + m;
}

// POST /api/attendance/ping — FIX: proper entry/exit tracking
router.post('/ping', authMiddleware, async (req, res) => {
  try {
    const { lat, lng, accuracy, speed, altitude, is_mock } = req.body;
    const studentId = req.user.id;

    if (!lat || !lng)
      return res.status(400).json({ error: 'Location required' });

    const fakeCheck = detectFakeGPS(accuracy, speed, altitude);
    if (is_mock || fakeCheck.isFake) {
      dbRun(`INSERT INTO location_events
             (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
             VALUES (?,?,'fake_gps_attempt',?,?,?,1,?)`,
        [uuidv4(), studentId, lat, lng, accuracy||0, nowISO()]);
      return res.json({ inside: false, fakeGPS: true, reason: fakeCheck.reasons?.join(', ') });
    }

    const user      = dbGet('SELECT * FROM users WHERE id=?', [studentId]);
    const classInfo = user ? dbGet('SELECT * FROM classes WHERE class_code=?', [user.class_code]) : null;

    if (!classInfo?.lat) {
      return res.json({ inside: false, distance: null, message: 'College location not set' });
    }

    const geo     = isInsideGeofence(parseFloat(lat), parseFloat(lng), classInfo.lat, classInfo.lng, classInfo.radius_meters||200);
    const time    = isCollegeTime(classInfo.start_time, classInfo.end_time, classInfo.lunch_start, classInfo.lunch_end);
    const date    = todayDate();
    const today   = getTodayDayName();
    const curMin  = new Date().getHours() * 60 + new Date().getMinutes();

    // Aaj ke periods mein se current period
    const todayPeriods = dbAll(
      'SELECT * FROM periods WHERE class_code=? AND day=? ORDER BY period_number',
      [user.class_code, today]
    );
    const currentPeriod = todayPeriods.find(p =>
      curMin >= timeToMinutes(p.start_time) && curMin <= timeToMinutes(p.end_time)
    ) || { period_number: 0, subject: 'General', id: null };

    // General session (period_number=0) — daily tracking ke liye
    let genSession = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
      [studentId, date]
    );

    const now = nowISO();

    if (geo.inside && time.isOpen && !time.isLunch) {
      // Student andar hai
      if (!genSession) {
        // Pehli baar aaya — entry record karo
        const sid = uuidv4();
        dbRun(`INSERT INTO attendance_sessions
               (id,student_id,class_code,date,period_number,subject,
                entry_time,status,method,total_minutes,created_at)
               VALUES (?,?,?,?,0,'General',?,'present','auto',0,?)`,
          [sid, studentId, user.class_code, date, now, now]);
        genSession = dbGet('SELECT * FROM attendance_sessions WHERE id=?', [sid]);

        // Location event
        dbRun(`INSERT INTO location_events
               (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
               VALUES (?,?,'entry',?,?,?,0,?)`,
          [uuidv4(), studentId, lat, lng, accuracy||10, now]);
      } else if (genSession.status === 'absent') {
        // Wapas aaya — resume karo
        dbRun(`UPDATE attendance_sessions
               SET status='present', entry_time=?
               WHERE id=?`, [now, genSession.id]);

        dbRun(`INSERT INTO location_events
               (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
               VALUES (?,?,'re_entry',?,?,?,0,?)`,
          [uuidv4(), studentId, lat, lng, accuracy||10, now]);

        genSession = dbGet('SELECT * FROM attendance_sessions WHERE id=?', [genSession.id]);
      }

      // FIX: total_minutes = accumulated + current session time
      if (genSession?.entry_time) {
        const entryMs     = new Date(genSession.entry_time).getTime();
        const nowMs       = Date.now();
        const currentMins = Math.max(0, Math.floor((nowMs - entryMs) / 60000));
        const accumulated = parseInt(genSession.accumulated_minutes) || 0;
        const totalMins   = accumulated + currentMins;
        dbRun('UPDATE attendance_sessions SET total_minutes=? WHERE id=?',
          [totalMins, genSession.id]);
      }

      // Period-wise session
      if (currentPeriod.id) {
        const periodSession = dbGet(
          'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
          [studentId, date, currentPeriod.period_number]
        );
        if (!periodSession) {
          dbRun(`INSERT INTO attendance_sessions
                 (id,student_id,class_code,date,period_id,period_number,
                  subject,entry_time,status,method,total_minutes,created_at)
                 VALUES (?,?,?,?,?,?,?,?,'present','auto',0,?)`,
            [uuidv4(), studentId, user.class_code, date,
             currentPeriod.id, currentPeriod.period_number,
             currentPeriod.subject, now, now]);
        }
      }

    } else if (!geo.inside && genSession?.status === 'present') {
      // FIX: Student bahar gaya — time freeze karo
      const entryMs     = new Date(genSession.entry_time).getTime();
      const nowMs       = Date.now();
      const currentMins = Math.max(0, Math.floor((nowMs - entryMs) / 60000));
      const accumulated = parseInt(genSession.accumulated_minutes) || 0;
      const totalMins   = accumulated + currentMins;

      dbRun(`UPDATE attendance_sessions
             SET status='absent', exit_time=?, total_minutes=?, accumulated_minutes=?
             WHERE id=?`,
        [now, totalMins, totalMins, genSession.id]);

      dbRun(`INSERT INTO location_events
             (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
             VALUES (?,?,'exit',?,?,?,0,?)`,
        [uuidv4(), studentId, lat, lng, accuracy||10, now]);
    }

    // Fresh session fetch
    const updatedSession = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
      [studentId, date]
    );
    const allSessions = dbAll(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? ORDER BY period_number',
      [studentId, date]
    );

    // FIX: Attendance % — unique dates count karo, sessions nahi
    const allDates    = dbAll(`
      SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
      FROM attendance_sessions WHERE student_id=? AND period_number=0
      GROUP BY date ORDER BY date DESC LIMIT 60
    `, [studentId]);
    const totalDays   = allDates.length;
    const presentDays = allDates.filter(d => d.was_present).length;
    const pct         = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

    const pending = dbGet(
      `SELECT * FROM verify_logs WHERE student_id=? AND result='pending' ORDER BY sent_at DESC LIMIT 1`,
      [studentId]
    );

    res.json({
      inside:         geo.inside,
      distance:       Math.round(geo.distance || 0),
      isLunch:        time.isLunch,
      isCollegeTime:  time.isOpen,
      fakeGPS:        false,
      warning75:      pct < 75,
      attendancePct:  pct,
      currentPeriod,
      todayDay:       today,
      sessions:       allSessions,
      totalMinutes:   updatedSession?.total_minutes || 0,
      entryTime:      updatedSession?.entry_time || null,
      exitTime:       updatedSession?.exit_time || null,
      pending:        pending || null,
    });
  } catch(e) {
    console.error('Ping error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/attendance/today
router.get('/today', authMiddleware, (req, res) => {
  try {
    const date     = todayDate();
    const sessions = dbAll(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? ORDER BY period_number',
      [req.user.id, date]
    );
    const events = dbAll(
      'SELECT * FROM location_events WHERE student_id=? AND date(timestamp)=? ORDER BY timestamp',
      [req.user.id, date]
    );
    const gen        = sessions.find(s => s.period_number === 0);
    const totalMin   = gen?.total_minutes || 0;

    res.json({
      sessions, events,
      totalMinutes: totalMin,
      entryTime:   gen?.entry_time || null,
      exitTime:    gen?.exit_time || null,
      percentage:  Math.min(100, Math.round((totalMin / 360) * 100)),
      status:      gen?.status || 'absent',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance/history — FIX: proper grouping
router.get('/history', authMiddleware, (req, res) => {
  try {
    const studentId = req.user.id;

    // General sessions — per day (period_number=0)
    const general = dbAll(`
      SELECT date, entry_time, exit_time, total_minutes, status, method
      FROM attendance_sessions
      WHERE student_id=? AND period_number=0
      ORDER BY date DESC LIMIT 60
    `, [studentId]);

    // Period sessions
    const periods = dbAll(`
      SELECT s.*, p.subject as period_subject, p.start_time as period_start, p.end_time as period_end
      FROM attendance_sessions s
      LEFT JOIN periods p ON p.id = s.period_id
      WHERE s.student_id=? AND s.period_number > 0
      ORDER BY s.date DESC, s.period_number ASC LIMIT 100
    `, [studentId]);

    // Verify logs — verification history
    const verifications = dbAll(`
      SELECT vl.*, u.name as teacher_name
      FROM verify_logs vl
      LEFT JOIN attendance_sessions s ON s.id = vl.session_id
      LEFT JOIN classes c ON c.class_code = s.class_code
      LEFT JOIN users u ON u.id = c.teacher_id
      WHERE vl.student_id=?
      ORDER BY vl.sent_at DESC LIMIT 60
    `, [studentId]);

    // FIX: Attendance % by unique days
    const totalDays   = general.length;
    const presentDays = general.filter(d => d.status === 'present').length;
    const pct         = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    res.json({
      general,
      periods,
      verifications,
      analytics: {
        total_days:   totalDays,
        present_days: presentDays,
        absent_days:  totalDays - presentDays,
        percentage:   pct,
        warning_75:   pct < 75,
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/attendance/correction-request
router.post('/correction-request', authMiddleware, (req, res) => {
  try {
    const { session_date, period_number = 0, subject, reason } = req.body;
    if (!session_date || !reason?.trim())
      return res.status(400).json({ error: 'Date and reason required' });

    const id = uuidv4();
    dbRun(`INSERT INTO correction_requests
           (id,student_id,session_date,period_number,subject,reason,status,requested_at)
           VALUES (?,?,?,?,?,?,'pending',?)`,
      [id, req.user.id, session_date, period_number, subject||'General', reason.trim(), nowISO()]);

    res.json({ message: 'Correction request submitted!', id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance/correction-requests — teacher ke liye
router.get('/correction-requests', authMiddleware, (req, res) => {
  try {
    const requests = dbAll(`
      SELECT cr.*, u.name as student_name, u.roll_no, u.email as student_email
      FROM correction_requests cr
      JOIN users u ON u.id = cr.student_id
      WHERE u.class_code=?
      ORDER BY cr.requested_at DESC
    `, [req.user.class_code]);
    res.json({ requests });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/attendance/correction-request/:id
router.put('/correction-request/:id', authMiddleware, (req, res) => {
  try {
    const { status, teacher_note } = req.body;
    if (!['approved','rejected'].includes(status))
      return res.status(400).json({ error: 'Status must be approved or rejected' });

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
          dbRun(`UPDATE attendance_sessions SET status='present', method='corrected' WHERE id=?`,
            [existing.id]);
        } else {
          dbRun(`INSERT INTO attendance_sessions
                 (id,student_id,date,period_number,subject,status,method,entry_time,created_at)
                 VALUES (?,?,?,?,?,'present','corrected',?,?)`,
            [uuidv4(), cr.student_id, cr.session_date,
             cr.period_number||0, cr.subject||'General', nowISO(), nowISO()]);
        }
      }
    }
    res.json({ message: `Correction ${status}!` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/attendance/cancel — FIX 15: Teacher can cancel attendance
router.post('/cancel', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { student_id, date, period_number = 0, reason } = req.body
    if (!student_id || !date)
      return res.status(400).json({ error: 'student_id and date required' })
    if (!reason?.trim())
      return res.status(400).json({ error: 'Reason required for cancellation' })

    const session = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
      [student_id, date, period_number]
    )

    const now = new Date().toISOString()

    if (session) {
      const prevStatus = session.status
      dbRun(
        `UPDATE attendance_sessions
         SET status='cancelled', total_minutes=0, exit_time=?
         WHERE student_id=? AND date=? AND period_number=?`,
        [now, student_id, date, period_number]
      )

      // Audit log
      dbRun(`INSERT INTO correction_requests
             (id,student_id,session_date,period_number,subject,reason,status,teacher_note,requested_at,resolved_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), student_id, date, period_number, session.subject||'General',
         `CANCELLED by teacher: ${reason}`, 'cancelled',
         `Previous status: ${prevStatus}`, now, now])
    } else {
      // Create cancelled session for audit
      dbRun(`INSERT INTO attendance_sessions
             (id,student_id,class_code,date,period_number,subject,status,method,total_minutes,created_at)
             VALUES (?,?,?,?,?,?,?,?,0,?)`,
        [uuidv4(), student_id, req.user.class_code, date, period_number, 'General', 'cancelled', 'cancelled', now])
    }

    // Notify student
    const student = dbGet('SELECT name, push_token FROM users WHERE id=?', [student_id])
    if (student?.push_token && global.io) {
      global.io.to(`user_${student_id}`).emit('attendance_cancelled', {
        date, period_number, reason,
        message: `Your attendance for ${date} has been cancelled by your teacher.`,
      })
    }

    res.json({ message: `Attendance cancelled for ${student?.name||student_id} on ${date}` })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/attendance/cancelled-history — Audit log
router.get('/cancelled-history', authMiddleware, teacherOnly, (req, res) => {
  try {
    const logs = dbAll(`
      SELECT s.*, u.name as student_name, u.roll_no
      FROM attendance_sessions s
      JOIN users u ON u.id=s.student_id
      WHERE s.class_code=? AND s.status='cancelled'
      ORDER BY s.created_at DESC LIMIT 50
    `, [req.user.class_code])
    res.json({ logs })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/attendance/pending-verify
router.get('/pending-verify', authMiddleware, (req, res) => {
  try {
    const pending = dbGet(
      `SELECT * FROM verify_logs WHERE student_id=? AND result='pending' ORDER BY sent_at DESC LIMIT 1`,
      [req.user.id]
    );
    const remaining = pending
      ? Math.max(0, (parseInt(process.env.VERIFY_WINDOW_MINUTES||10) * 60) -
          Math.floor((Date.now() - new Date(pending.sent_at).getTime()) / 1000))
      : 0;

    res.json({ pending: pending || null, remaining_seconds: remaining });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;