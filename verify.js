/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Fast verification response
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// POST /api/verify/send — Teacher sends verify to all students
router.post('/send', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { student_id, period_number = 0, subject = 'General' } = req.body;
    const classCode = req.user.class_code;
    const date      = new Date().toISOString().split('T')[0];
    const now       = nowISO();

    const students = student_id
      ? [dbGet('SELECT id,email,name,push_token FROM users WHERE id=?', [student_id])].filter(Boolean)
      : dbAll('SELECT id,email,name,push_token FROM users WHERE class_code=? AND role=?', [classCode, 'student']);

    let sent = 0;
    students.forEach(student => {
      // Get or create session
      let session = dbGet(
        'SELECT id FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
        [student.id, date, period_number]
      );
      if (!session) {
        const sid = uuidv4();
        dbRun(`INSERT INTO attendance_sessions
               (id,student_id,class_code,date,period_number,subject,status,method,created_at)
               VALUES (?,?,?,?,?,?,'present','auto',?)`,
          [sid, student.id, classCode, date, period_number, subject, now]);
        session = { id: sid };
      }

      // Check no duplicate pending
      const existing = dbGet(
        `SELECT id FROM verify_logs WHERE student_id=? AND session_id=? AND result='pending'`,
        [student.id, session.id]
      );
      if (existing) return;

      dbRun(`INSERT INTO verify_logs
             (id,student_id,session_id,period_number,subject,sent_at,result)
             VALUES (?,?,?,?,?,?,'pending')`,
        [uuidv4(), student.id, session.id, period_number, subject, now]);

      // Push notification
      if (student.push_token && global.io) {
        global.io.to(`user_${student.id}`).emit('verify_alert', {
          period_number, subject, sent_at: now,
          window_minutes: parseInt(process.env.VERIFY_WINDOW_MINUTES || 10),
        });
      }
      sent++;
    });

    res.json({ message: `Verify sent to ${sent} students`, sent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/verify/respond — FIX: Fast response, no heavy processing
router.post('/respond', authMiddleware, async (req, res) => {
  try {
    const studentId = req.user.id;
    const { verify_log_id } = req.body;

    // Find pending verify
    let log = null;
    if (verify_log_id) {
      log = dbGet('SELECT * FROM verify_logs WHERE id=? AND student_id=? AND result=?',
        [verify_log_id, studentId, 'pending']);
    }
    if (!log) {
      log = dbGet(
        `SELECT * FROM verify_logs WHERE student_id=? AND result='pending' ORDER BY sent_at DESC LIMIT 1`,
        [studentId]
      );
    }

    if (!log) return res.status(400).json({ error: 'No pending verification found' });

    // Check time window
    const windowMs  = parseInt(process.env.VERIFY_WINDOW_MINUTES || 10) * 60 * 1000;
    const sentMs    = new Date(log.sent_at).getTime();
    if (Date.now() - sentMs > windowMs) {
      dbRun('UPDATE verify_logs SET result=? WHERE id=?', ['timeout', log.id]);
      return res.status(400).json({ error: 'Verification window expired. Ask teacher to resend.' });
    }

    // FIX: Quick update — no face analysis delay
    const now = nowISO();
    dbRun('UPDATE verify_logs SET result=?, responded_at=? WHERE id=?', ['verified', now, log.id]);

    // Update attendance
    dbRun(`UPDATE attendance_sessions SET status='present' WHERE id=?`, [log.session_id]);

    // Notify teacher via socket
    const session   = dbGet('SELECT class_code FROM attendance_sessions WHERE id=?', [log.session_id]);
    const student   = dbGet('SELECT name FROM users WHERE id=?', [studentId]);

    if (global.io && session?.class_code) {
      global.io.to(`class_${session.class_code}`).emit('student_verified', {
        student_id:   studentId,
        student_name: student?.name,
        period_number: log.period_number,
        subject:       log.subject,
        verified_at:   now,
      });
    }

    res.json({ success: true, message: 'Attendance verified!' });
  } catch(e) {
    console.error('Verify respond error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/verify/pending — Student's pending verifications
router.get('/pending', authMiddleware, (req, res) => {
  try {
    const windowMs = parseInt(process.env.VERIFY_WINDOW_MINUTES || 10) * 60 * 1000;
    const cutoff   = new Date(Date.now() - windowMs).toISOString();

    const logs = dbAll(`
      SELECT vl.*, s.date
      FROM verify_logs vl
      JOIN attendance_sessions s ON s.id=vl.session_id
      WHERE vl.student_id=? AND vl.result='pending' AND vl.sent_at > ?
      ORDER BY vl.sent_at DESC
    `, [req.user.id, cutoff]);

    const enriched = logs.map(log => ({
      ...log,
      remaining_seconds: Math.max(0, Math.floor(
        (new Date(log.sent_at).getTime() + windowMs - Date.now()) / 1000
      )),
    }));

    res.json({ pending: enriched, count: enriched.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/verify/history — Student's verification history
router.get('/history', authMiddleware, (req, res) => {
  try {
    const logs = dbAll(`
      SELECT vl.*, s.date
      FROM verify_logs vl
      JOIN attendance_sessions s ON s.id=vl.session_id
      WHERE vl.student_id=?
      ORDER BY vl.sent_at DESC LIMIT 50
    `, [req.user.id]);

    res.json({ logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/verify/teacher-history — Teacher's sent verifications
router.get('/teacher-history', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const logs      = dbAll(`
      SELECT
        vl.id, vl.sent_at, vl.result, vl.period_number, vl.subject,
        s.date, u.name as student_name, u.roll_no
      FROM verify_logs vl
      JOIN attendance_sessions s ON s.id=vl.session_id
      JOIN users u ON u.id=vl.student_id
      WHERE s.class_code=?
      ORDER BY vl.sent_at DESC LIMIT 200
    `, [classCode]);

    res.json({ logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;