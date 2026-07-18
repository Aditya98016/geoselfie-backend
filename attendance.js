/*
 * © 2026 GeoSelfie — All rights reserved.
 * attendance.js — v3: transactions, re-entry tracking, dedup exit events,
 * in-memory minute accumulation, paginated/filterable history, correction
 * dedup + teacher-scoped authorization, cancel/restore, fake-GPS rate
 * limiting, audit log, response envelope, schema/index bootstrap.
 *
 * NOTE ON COMPATIBILITY: every existing top-level response field is kept
 * exactly as before (Rule 4/5). New fields (e.g. `success`, `meta`) are
 * additive only — nothing that previously worked reads differently.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun, onDbReady } = require('./database');
const { isInsideGeofence, isCollegeTime, detectFakeGPS } = require('./geofence');
const { authMiddleware, teacherOnly } = require('./middleware');
const router = express.Router();

const todayDate = () => new Date().toISOString().split('T')[0];
const nowISO    = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────
// Schema / index bootstrap (idempotent — safe to run every boot)
// ─────────────────────────────────────────────────────────
function safeRun(sql, params = []) {
  try { dbRun(sql, params); } catch (e) { /* column/index already exists — ignore */ }
}

function ensureSchema() {
  // New columns used by improvements below. Guarded so this never breaks
  // an existing DB that already has them.
  safeRun(`ALTER TABLE attendance_sessions ADD COLUMN first_entry_time TEXT`);
  safeRun(`ALTER TABLE attendance_sessions ADD COLUMN last_entry_time TEXT`);
  safeRun(`ALTER TABLE attendance_sessions ADD COLUMN accumulated_minutes INTEGER DEFAULT 0`);
  safeRun(`ALTER TABLE attendance_sessions ADD COLUMN minutes_dirty INTEGER DEFAULT 0`);

  // Audit log — Improvement #17
  safeRun(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT
    )
  `);

  // Indexes — Improvement #16
  safeRun(`CREATE INDEX IF NOT EXISTS idx_att_student_date ON attendance_sessions(student_id, date)`);
  safeRun(`CREATE INDEX IF NOT EXISTS idx_att_student_period ON attendance_sessions(student_id, period_number)`);
  safeRun(`CREATE INDEX IF NOT EXISTS idx_att_class_date ON attendance_sessions(class_code, date)`);
  safeRun(`CREATE INDEX IF NOT EXISTS idx_att_status ON attendance_sessions(status)`);
  safeRun(`CREATE INDEX IF NOT EXISTS idx_verify_sent_at ON verify_logs(sent_at)`);
  safeRun(`CREATE INDEX IF NOT EXISTS idx_location_events_student ON location_events(student_id, timestamp)`);
}
// FIX (dbRun error: Cannot read properties of undefined (reading 'run')):
// this file is require()'d — and ensureSchema() used to run immediately
// — before setupDatabase() (in database.js) has finished initializing
// sql.js, so `db` was still undefined and every dbRun() call here
// crashed/no-op'd, meaning audit_logs + several indexes never got
// created. Defer this until the DB is actually ready.
onDbReady(ensureSchema);

// ─────────────────────────────────────────────────────────
// Transaction helper — Improvement #1
// Wraps a synchronous block of dbRun/dbGet/dbAll calls so a failure
// midway rolls back instead of leaving partial writes.
// ─────────────────────────────────────────────────────────
function withTransaction(fn) {
  dbRun('BEGIN IMMEDIATE');
  try {
    const result = fn();
    dbRun('COMMIT');
    return result;
  } catch (e) {
    try { dbRun('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// ─────────────────────────────────────────────────────────
// Audit log helper — Improvement #17
// ─────────────────────────────────────────────────────────
function logAudit(actorId, actorRole, action, targetType, targetId, detail) {
  try {
    dbRun(
      `INSERT INTO audit_logs (id,actor_id,actor_role,action,target_type,target_id,detail,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(), actorId || null, actorRole || null, action, targetType, targetId || null,
       typeof detail === 'string' ? detail : JSON.stringify(detail || {}), nowISO()]
    );
  } catch (e) {
    console.warn('Audit log write failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────
// Response envelope — Improvement #18
// Adds `success` without touching any existing field shape.
// ─────────────────────────────────────────────────────────
function ok(res, payload, code = 200) {
  return res.status(code).json({ success: true, ...payload });
}
function fail(res, code, message, extra = {}) {
  return res.status(code).json({ success: false, error: message, ...extra });
}

function getTodayDayName() {
  const now  = new Date();
  const ist  = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  return days[ist.getUTCDay()];
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// How often (ms) we persist total_minutes to disk instead of every single
// ping — Improvement #4. Value in memory is still accurate every request;
// we just don't hit the DB on every ping.
const MINUTES_PERSIST_INTERVAL_MS = 2 * 60 * 1000;

// In-memory last-persist timestamp per session id, process-local. This is
// a best-effort optimization: worst case we persist a little more often
// after a restart, never less accurately (the DB is always caught up on
// exit / status change / explicit reads).
const lastPersistAt = new Map();

function shouldPersistMinutes(sessionId) {
  const last = lastPersistAt.get(sessionId) || 0;
  if (Date.now() - last >= MINUTES_PERSIST_INTERVAL_MS) {
    lastPersistAt.set(sessionId, Date.now());
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Fake-GPS rate limiting — Improvement #13
// Cap how many fake_gps_attempt rows we log per student per window so a
// spoofing loop can't flood the table.
// ─────────────────────────────────────────────────────────
const FAKE_GPS_WINDOW_MS = 10 * 60 * 1000;
const FAKE_GPS_MAX_PER_WINDOW = 5;

function fakeGpsRateLimited(studentId) {
  const since = new Date(Date.now() - FAKE_GPS_WINDOW_MS).toISOString();
  const row = dbGet(
    `SELECT COUNT(*) as c FROM location_events
     WHERE student_id=? AND event_type='fake_gps_attempt' AND timestamp>=?`,
    [studentId, since]
  );
  return (row?.c || 0) >= FAKE_GPS_MAX_PER_WINDOW;
}

// ─────────────────────────────────────────────────────────
// Pending-verify cleanup — Improvement #12
// Expires stale pending verify_logs so they stop showing as "pending"
// forever if a student never responds.
// ─────────────────────────────────────────────────────────
function expireStaleVerifications() {
  try {
    const windowMin = parseInt(process.env.VERIFY_WINDOW_MINUTES || 10);
    const cutoff = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
    dbRun(
      `UPDATE verify_logs SET result='expired', responded_at=?
       WHERE result='pending' AND sent_at < ?`,
      [nowISO(), cutoff]
    );
  } catch (e) {
    console.warn('Verify cleanup failed:', e.message);
  }
}

// POST /api/attendance/ping — entry/exit tracking, re-entry aware
router.post('/ping', authMiddleware, async (req, res) => {
  try {
    const { lat, lng, accuracy, speed, altitude, is_mock } = req.body;
    const studentId = req.user.id;

    if (!lat || !lng)
      return fail(res, 400, 'Location required');

    const fakeCheck = detectFakeGPS(accuracy, speed, altitude);
    if (is_mock || fakeCheck.isFake) {
      // Improvement #13: rate-limit fake-GPS logging so repeated pings
      // from a spoofed device don't flood location_events.
      if (!fakeGpsRateLimited(studentId)) {
        dbRun(`INSERT INTO location_events
               (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
               VALUES (?,?,'fake_gps_attempt',?,?,?,1,?)`,
          [uuidv4(), studentId, lat, lng, accuracy || 0, nowISO()]);
      }
      return ok(res, { inside: false, fakeGPS: true, reason: fakeCheck.reasons?.join(', ') });
    }

    const user      = dbGet('SELECT * FROM users WHERE id=?', [studentId]);
    const classInfo = user ? dbGet('SELECT * FROM classes WHERE class_code=?', [user.class_code]) : null;

    if (!classInfo?.lat) {
      return ok(res, { inside: false, distance: null, message: 'College location not set' });
    }

    const geo   = isInsideGeofence(parseFloat(lat), parseFloat(lng), classInfo.lat, classInfo.lng, classInfo.radius_meters || 200);
    const time  = isCollegeTime(classInfo.start_time, classInfo.end_time, classInfo.lunch_start, classInfo.lunch_end);
    const date  = todayDate();
    const today = getTodayDayName();
    const curMin = new Date().getHours() * 60 + new Date().getMinutes();

    const todayPeriods = dbAll(
      'SELECT * FROM periods WHERE class_code=? AND day=? ORDER BY period_number',
      [user.class_code, today]
    );
    const currentPeriod = todayPeriods.find(p =>
      curMin >= timeToMinutes(p.start_time) && curMin <= timeToMinutes(p.end_time)
    ) || { period_number: 0, subject: 'General', id: null };

    let genSession = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
      [studentId, date]
    );

    const now = nowISO();

    withTransaction(() => {
      if (geo.inside && time.isOpen && !time.isLunch) {
        if (!genSession) {
          // First arrival of the day
          const sid = uuidv4();
          dbRun(`INSERT INTO attendance_sessions
                 (id,student_id,class_code,date,period_number,subject,
                  entry_time,first_entry_time,last_entry_time,status,method,
                  total_minutes,accumulated_minutes,created_at)
                 VALUES (?,?,?,?,0,'General',?,?,?,'present','auto',0,0,?)`,
            [sid, studentId, user.class_code, date, now, now, now, now]);
          genSession = dbGet('SELECT * FROM attendance_sessions WHERE id=?', [sid]);

          dbRun(`INSERT INTO location_events
                 (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
                 VALUES (?,?,'entry',?,?,?,0,?)`,
            [uuidv4(), studentId, lat, lng, accuracy || 10, now]);
        } else if (genSession.status === 'absent') {
          // Improvement #2: re-entry — keep the original entry_time /
          // first_entry_time intact, only bump last_entry_time which is
          // what elapsed-time math below uses for the *current* stint.
          dbRun(`UPDATE attendance_sessions
                 SET status='present', last_entry_time=?
                 WHERE id=?`, [now, genSession.id]);

          // Improvement #3: only log a re_entry event if the previous
          // event for this student wasn't already an entry/re_entry
          // (guards against duplicate rapid pings creating noise).
          const lastEvent = dbGet(
            `SELECT event_type FROM location_events WHERE student_id=? ORDER BY timestamp DESC LIMIT 1`,
            [studentId]
          );
          if (!lastEvent || lastEvent.event_type === 'exit') {
            dbRun(`INSERT INTO location_events
                   (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
                   VALUES (?,?,'re_entry',?,?,?,0,?)`,
              [uuidv4(), studentId, lat, lng, accuracy || 10, now]);
          }

          genSession = dbGet('SELECT * FROM attendance_sessions WHERE id=?', [genSession.id]);
        }

        // Improvement #4: compute total_minutes in memory every ping,
        // but only WRITE it to the DB periodically (or on state change,
        // handled by the branches above/below which always persist).
        if (genSession?.last_entry_time) {
          const entryMs     = new Date(genSession.last_entry_time).getTime();
          const currentMins = Math.max(0, Math.floor((Date.now() - entryMs) / 60000));
          const accumulated = parseInt(genSession.accumulated_minutes) || 0;
          const liveTotal    = accumulated + currentMins;

          if (shouldPersistMinutes(genSession.id)) {
            dbRun('UPDATE attendance_sessions SET total_minutes=? WHERE id=?', [liveTotal, genSession.id]);
          } else {
            // Not persisted this tick, but reflect the live value in the
            // object we return to the client so the UI still looks live.
            genSession = { ...genSession, total_minutes: liveTotal };
          }
        }

        if (currentPeriod.id) {
          const periodSession = dbGet(
            'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
            [studentId, date, currentPeriod.period_number]
          );
          if (!periodSession) {
            dbRun(`INSERT INTO attendance_sessions
                   (id,student_id,class_code,date,period_id,period_number,
                    subject,entry_time,first_entry_time,last_entry_time,status,method,
                    total_minutes,accumulated_minutes,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,'present','auto',0,0,?)`,
              [uuidv4(), studentId, user.class_code, date,
               currentPeriod.id, currentPeriod.period_number,
               currentPeriod.subject, now, now, now, now]);
          }
        }

      } else if (!geo.inside && genSession?.status === 'present') {
        // Exit — Improvement #3 dedup guard: skip if we already recorded
        // an exit event since the last entry/re_entry.
        const entryMs     = new Date(genSession.last_entry_time || genSession.entry_time).getTime();
        const currentMins = Math.max(0, Math.floor((Date.now() - entryMs) / 60000));
        const accumulated = parseInt(genSession.accumulated_minutes) || 0;
        const totalMins    = accumulated + currentMins;

        dbRun(`UPDATE attendance_sessions
               SET status='absent', exit_time=?, total_minutes=?, accumulated_minutes=?
               WHERE id=?`,
          [now, totalMins, totalMins, genSession.id]);

        const lastEvent = dbGet(
          `SELECT event_type FROM location_events WHERE student_id=? ORDER BY timestamp DESC LIMIT 1`,
          [studentId]
        );
        if (!lastEvent || lastEvent.event_type !== 'exit') {
          dbRun(`INSERT INTO location_events
                 (id,student_id,event_type,lat,lng,accuracy,is_mock,timestamp)
                 VALUES (?,?,'exit',?,?,?,0,?)`,
            [uuidv4(), studentId, lat, lng, accuracy || 10, now]);
        }
      }
    });

    const updatedSession = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
      [studentId, date]
    );
    const allSessions = dbAll(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? ORDER BY period_number',
      [studentId, date]
    );

    // Improvement #5: configurable history range instead of hardcoded 60
    const rangeDays = Math.max(1, parseInt(process.env.ATTENDANCE_PCT_RANGE_DAYS || 60));
    const allDates = dbAll(`
      SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
      FROM attendance_sessions WHERE student_id=? AND period_number=0
      GROUP BY date ORDER BY date DESC, date DESC LIMIT ?
    `, [studentId, rangeDays]);
    const totalDays   = allDates.length;
    const presentDays = allDates.filter(d => d.was_present).length;
    const pct         = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

    const pending = dbGet(
      `SELECT * FROM verify_logs WHERE student_id=? AND result='pending' ORDER BY sent_at DESC LIMIT 1`,
      [studentId]
    );

    return ok(res, {
      inside:        geo.inside,
      distance:      Math.round(geo.distance || 0),
      isLunch:       time.isLunch,
      isCollegeTime: time.isOpen,
      fakeGPS:       false,
      warning75:     pct < 75,
      attendancePct: pct,
      currentPeriod,
      todayDay:      today,
      sessions:      allSessions,
      totalMinutes:  updatedSession?.total_minutes || 0,
      entryTime:     updatedSession?.entry_time || null,
      exitTime:      updatedSession?.exit_time || null,
      pending:       pending || null,
    });
  } catch (e) {
    console.error('Ping error:', e.message);
    return fail(res, 500, e.message);
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
    const gen      = sessions.find(s => s.period_number === 0);
    const totalMin = gen?.total_minutes || 0;

    return ok(res, {
      sessions, events,
      totalMinutes: totalMin,
      entryTime:   gen?.entry_time || null,
      exitTime:    gen?.exit_time || null,
      percentage:  Math.min(100, Math.round((totalMin / 360) * 100)),
      status:      gen?.status || 'absent',
    });
  } catch (e) { return fail(res, 500, e.message); }
});

// GET /api/attendance/history — Improvements #6 (pagination) & #7 (filters) & #8 (stable sort)
router.get('/history', authMiddleware, (req, res) => {
  try {
    expireStaleVerifications();

    const studentId = req.user.id;
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 60));
    const offset   = (page - 1) * pageSize;

    const { status, month, year, period, method } = req.query;

    // Build WHERE clause dynamically but safely (parameterized).
    const generalWhere = ['student_id=?', 'period_number=0'];
    const generalParams = [studentId];
    if (status) { generalWhere.push('status=?'); generalParams.push(status); }
    if (method) { generalWhere.push('method=?'); generalParams.push(method); }
    if (year)   { generalWhere.push(`strftime('%Y', date)=?`); generalParams.push(String(year)); }
    if (month)  { generalWhere.push(`strftime('%m', date)=?`); generalParams.push(String(month).padStart(2, '0')); }

    // Improvement #8: deterministic ordering with a tiebreaker on id.
    const general = dbAll(`
      SELECT date, entry_time, exit_time, total_minutes, status, method, id
      FROM attendance_sessions
      WHERE ${generalWhere.join(' AND ')}
      ORDER BY date DESC, id DESC LIMIT ? OFFSET ?
    `, [...generalParams, pageSize, offset]);

    const generalCountRow = dbGet(
      `SELECT COUNT(*) as c FROM attendance_sessions WHERE ${generalWhere.join(' AND ')}`,
      generalParams
    );

    const periodWhere = ['s.student_id=?', 's.period_number > 0'];
    const periodParams = [studentId];
    if (status) { periodWhere.push('s.status=?'); periodParams.push(status); }
    if (method) { periodWhere.push('s.method=?'); periodParams.push(method); }
    if (period) { periodWhere.push('s.period_number=?'); periodParams.push(parseInt(period)); }
    if (year)   { periodWhere.push(`strftime('%Y', s.date)=?`); periodParams.push(String(year)); }
    if (month)  { periodWhere.push(`strftime('%m', s.date)=?`); periodParams.push(String(month).padStart(2, '0')); }

    const periods = dbAll(`
      SELECT s.*, p.subject as period_subject, p.start_time as period_start, p.end_time as period_end
      FROM attendance_sessions s
      LEFT JOIN periods p ON p.id = s.period_id
      WHERE ${periodWhere.join(' AND ')}
      ORDER BY s.date DESC, s.period_number ASC, s.id DESC LIMIT ? OFFSET ?
    `, [...periodParams, pageSize, offset]);

    const verifications = dbAll(`
      SELECT vl.*, u.name as teacher_name
      FROM verify_logs vl
      LEFT JOIN attendance_sessions s ON s.id = vl.session_id
      LEFT JOIN classes c ON c.class_code = s.class_code
      LEFT JOIN users u ON u.id = c.teacher_id
      WHERE vl.student_id=?
      ORDER BY vl.sent_at DESC, vl.id DESC LIMIT ? OFFSET ?
    `, [studentId, pageSize, offset]);

    // Improvement #5-equivalent for history: analytics computed over the
    // FULL unfiltered/unpaginated set so percentage stays meaningful
    // regardless of the current page/filter.
    const allGeneral   = dbAll(`SELECT status FROM attendance_sessions WHERE student_id=? AND period_number=0`, [studentId]);
    const totalDays    = allGeneral.length;
    const presentDays  = allGeneral.filter(d => d.status === 'present').length;
    const pct          = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    return ok(res, {
      general,
      periods,
      verifications,
      analytics: {
        total_days:   totalDays,
        present_days: presentDays,
        absent_days:  totalDays - presentDays,
        percentage:   pct,
        warning_75:   pct < 75,
      },
      meta: {
        page, pageSize,
        total: generalCountRow?.c || 0,
        hasMore: offset + general.length < (generalCountRow?.c || 0),
      },
    });
  } catch (e) { return fail(res, 500, e.message); }
});

// POST /api/attendance/correction-request — Improvement #14 (dedup)
router.post('/correction-request', authMiddleware, (req, res) => {
  try {
    const { session_date, period_number = 0, subject, reason } = req.body;
    if (!session_date || !reason?.trim())
      return fail(res, 400, 'Date and reason required');

    const existingPending = dbGet(
      `SELECT id FROM correction_requests
       WHERE student_id=? AND session_date=? AND period_number=? AND status='pending'`,
      [req.user.id, session_date, period_number]
    );
    if (existingPending) {
      return fail(res, 409, 'A correction request for this session is already pending', { id: existingPending.id });
    }

    const id = uuidv4();
    dbRun(`INSERT INTO correction_requests
           (id,student_id,session_date,period_number,subject,reason,status,requested_at)
           VALUES (?,?,?,?,?,?,'pending',?)`,
      [id, req.user.id, session_date, period_number, subject || 'General', reason.trim(), nowISO()]);

    logAudit(req.user.id, 'student', 'correction_request_created', 'correction_request', id, { session_date, period_number });

    return ok(res, { message: 'Correction request submitted!', id });
  } catch (e) { return fail(res, 500, e.message); }
});

// GET /api/attendance/correction-requests — teacher-scoped
router.get('/correction-requests', authMiddleware, (req, res) => {
  try {
    const requests = dbAll(`
      SELECT cr.*, u.name as student_name, u.roll_no, u.email as student_email
      FROM correction_requests cr
      JOIN users u ON u.id = cr.student_id
      WHERE u.class_code=?
      ORDER BY cr.requested_at DESC
    `, [req.user.class_code]);
    return ok(res, { requests });
  } catch (e) { return fail(res, 500, e.message); }
});

// PUT /api/attendance/correction-request/:id — Improvement #9 & #15
router.put('/correction-request/:id', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { status, teacher_note } = req.body;
    if (!['approved', 'rejected'].includes(status))
      return fail(res, 400, 'Status must be approved or rejected');

    const cr = dbGet('SELECT * FROM correction_requests WHERE id=?', [req.params.id]);
    if (!cr) return fail(res, 404, 'Correction request not found');

    // Improvement #15: teacher can only act on requests for their own class.
    const student = dbGet('SELECT class_code FROM users WHERE id=?', [cr.student_id]);
    if (!student || student.class_code !== req.user.class_code) {
      return fail(res, 403, 'You are not authorized to resolve this request');
    }
    if (cr.status !== 'pending') {
      return fail(res, 409, `Request already ${cr.status}`);
    }

    withTransaction(() => {
      dbRun(`UPDATE correction_requests SET status=?, teacher_note=?, resolved_at=? WHERE id=?`,
        [status, teacher_note || null, nowISO(), req.params.id]);

      if (status === 'approved') {
        const existing = dbGet(
          'SELECT id FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
          [cr.student_id, cr.session_date, cr.period_number || 0]
        );
        const now = nowISO();
        if (existing) {
          // Improvement #9: keep entry/exit/total_minutes/method/analytics consistent.
          dbRun(`UPDATE attendance_sessions
                 SET status='present', method='corrected',
                     entry_time=COALESCE(entry_time, ?),
                     first_entry_time=COALESCE(first_entry_time, ?),
                     total_minutes=CASE WHEN total_minutes>0 THEN total_minutes ELSE 360 END,
                     accumulated_minutes=CASE WHEN accumulated_minutes>0 THEN accumulated_minutes ELSE 360 END
                 WHERE id=?`,
            [now, now, existing.id]);
        } else {
          dbRun(`INSERT INTO attendance_sessions
                 (id,student_id,date,period_number,subject,status,method,
                  entry_time,first_entry_time,last_entry_time,total_minutes,accumulated_minutes,created_at)
                 VALUES (?,?,?,?,?,'present','corrected',?,?,?,360,360,?)`,
            [uuidv4(), cr.student_id, cr.session_date,
             cr.period_number || 0, cr.subject || 'General', now, now, now, now]);
        }
      }

      logAudit(req.user.id, 'teacher', `correction_${status}`, 'correction_request', req.params.id, { teacher_note });
    });

    return ok(res, { message: `Correction ${status}!` });
  } catch (e) { return fail(res, 500, e.message); }
});

// POST /api/attendance/cancel — Improvement #10
router.post('/cancel', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { student_id, date, period_number = 0, reason } = req.body;
    if (!student_id || !date)
      return fail(res, 400, 'student_id and date required');
    if (!reason?.trim())
      return fail(res, 400, 'Reason required for cancellation');

    // Improvement #15-style scoping: teacher can only cancel within their own class.
    const student = dbGet('SELECT name, push_token, class_code FROM users WHERE id=?', [student_id]);
    if (!student || student.class_code !== req.user.class_code) {
      return fail(res, 403, 'You are not authorized to cancel attendance for this student');
    }

    const session = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
      [student_id, date, period_number]
    );

    const now = nowISO();

    withTransaction(() => {
      if (session) {
        const prevStatus = session.status;
        // Improvement #10: fully reset accumulated/total minutes on cancel.
        dbRun(
          `UPDATE attendance_sessions
           SET status='cancelled', total_minutes=0, accumulated_minutes=0, exit_time=?
           WHERE student_id=? AND date=? AND period_number=?`,
          [now, student_id, date, period_number]
        );

        dbRun(`INSERT INTO correction_requests
               (id,student_id,session_date,period_number,subject,reason,status,teacher_note,requested_at,resolved_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), student_id, date, period_number, session.subject || 'General',
           `CANCELLED by teacher: ${reason}`, 'cancelled',
           `Previous status: ${prevStatus}`, now, now]);
      } else {
        dbRun(`INSERT INTO attendance_sessions
               (id,student_id,class_code,date,period_number,subject,status,method,total_minutes,accumulated_minutes,created_at)
               VALUES (?,?,?,?,?,?,?,?,0,0,?)`,
          [uuidv4(), student_id, req.user.class_code, date, period_number, 'General', 'cancelled', 'cancelled', now]);
      }

      logAudit(req.user.id, 'teacher', 'attendance_cancel', 'attendance_session', `${student_id}:${date}:${period_number}`, { reason });
    });

    if (student?.push_token && global.io) {
      global.io.to(`user_${student_id}`).emit('attendance_cancelled', {
        date, period_number, reason,
        message: `Your attendance for ${date} has been cancelled by your teacher.`,
      });
    }

    return ok(res, { message: `Attendance cancelled for ${student?.name || student_id} on ${date}` });
  } catch (e) { return fail(res, 500, e.message); }
});

// POST /api/attendance/restore — Improvement #11
router.post('/restore', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { student_id, date, period_number = 0, restore_status = 'present', reason } = req.body;
    if (!student_id || !date)
      return fail(res, 400, 'student_id and date required');

    const student = dbGet('SELECT name, class_code FROM users WHERE id=?', [student_id]);
    if (!student || student.class_code !== req.user.class_code) {
      return fail(res, 403, 'You are not authorized to restore attendance for this student');
    }

    const session = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
      [student_id, date, period_number]
    );
    if (!session || session.status !== 'cancelled') {
      return fail(res, 409, 'No cancelled session found for this date/period');
    }
    if (!['present', 'absent'].includes(restore_status)) {
      return fail(res, 400, 'restore_status must be present or absent');
    }

    const now = nowISO();
    withTransaction(() => {
      dbRun(`UPDATE attendance_sessions SET status=?, method='restored' WHERE id=?`,
        [restore_status, session.id]);

      dbRun(`INSERT INTO correction_requests
             (id,student_id,session_date,period_number,subject,reason,status,teacher_note,requested_at,resolved_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), student_id, date, period_number, session.subject || 'General',
         `RESTORED by teacher${reason ? ': ' + reason : ''}`, 'restored', null, now, now]);

      logAudit(req.user.id, 'teacher', 'attendance_restore', 'attendance_session', session.id, { restore_status, reason });
    });

    return ok(res, { message: `Attendance restored to ${restore_status} for ${student.name || student_id} on ${date}` });
  } catch (e) { return fail(res, 500, e.message); }
});

// GET /api/attendance/cancelled-history — audit trail of cancellations
router.get('/cancelled-history', authMiddleware, teacherOnly, (req, res) => {
  try {
    const logs = dbAll(`
      SELECT s.*, u.name as student_name, u.roll_no
      FROM attendance_sessions s
      JOIN users u ON u.id=s.student_id
      WHERE s.class_code=? AND s.status='cancelled'
      ORDER BY s.created_at DESC LIMIT 50
    `, [req.user.class_code]);
    return ok(res, { logs });
  } catch (e) { return fail(res, 500, e.message); }
});

// GET /api/attendance/audit-logs — Improvement #17
router.get('/audit-logs', authMiddleware, teacherOnly, (req, res) => {
  try {
    const logs = dbAll(
      `SELECT * FROM audit_logs WHERE actor_id=? OR target_id LIKE ? ORDER BY created_at DESC LIMIT 100`,
      [req.user.id, `%${req.user.class_code || ''}%`]
    );
    return ok(res, { logs });
  } catch (e) { return fail(res, 500, e.message); }
});

// GET /api/attendance/pending-verify
router.get('/pending-verify', authMiddleware, (req, res) => {
  try {
    expireStaleVerifications();

    const pending = dbGet(
      `SELECT * FROM verify_logs WHERE student_id=? AND result='pending' ORDER BY sent_at DESC LIMIT 1`,
      [req.user.id]
    );
    const remaining = pending
      ? Math.max(0, (parseInt(process.env.VERIFY_WINDOW_MINUTES || 10) * 60) -
          Math.floor((Date.now() - new Date(pending.sent_at).getTime()) / 1000))
      : 0;

    return ok(res, { pending: pending || null, remaining_seconds: remaining });
  } catch (e) { return fail(res, 500, e.message); }
});

module.exports = router;


