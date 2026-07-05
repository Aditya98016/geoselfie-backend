/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');
const { isInsideGeofence, isCollegeTime } = require('./geofence');

const router = express.Router();
const today  = () => new Date().toISOString().split('T')[0];
const nowISO = () => new Date().toISOString();
const WINDOW = () => parseInt(process.env.VERIFY_WINDOW_MINUTES||10) * 60 * 1000;

function sendVerifyToClass(classCode) {
  const date     = today();
  const students = dbAll(`SELECT u.id FROM users u JOIN attendance_sessions s ON s.student_id = u.id WHERE s.date = ? AND s.status = 'present' AND u.class_code = ? AND u.role = 'student'`, [date, classCode]);
  let sent = 0;
  students.forEach(student => {
    const session = dbGet('SELECT id FROM attendance_sessions WHERE student_id = ? AND date = ?', [student.id, date]);
    if (!session) return;
    const pending = dbGet(`SELECT id FROM verify_logs WHERE student_id = ? AND session_id = ? AND result = 'pending'`, [student.id, session.id]);
    if (pending) return;
    dbRun(`INSERT INTO verify_logs (id, student_id, session_id, sent_at, result) VALUES (?, ?, ?, ?, 'pending')`, [uuidv4(), student.id, session.id, nowISO()]);
    sent++;
  });
  dbRun('UPDATE classes SET last_verify_sent_at = ? WHERE class_code = ?', [nowISO(), classCode]);
  return sent;
}

router.post('/teacher-ping', authMiddleware, teacherOnly, (req, res) => {
  const { lat, lng } = req.body;
  const classCode    = req.user.class_code;
  const classInfo    = dbGet('SELECT * FROM classes WHERE class_code = ?', [classCode]);

  if (!classInfo)     return res.status(404).json({ error: 'Class not found' });
  if (!classInfo.lat) return res.status(400).json({ error: 'College location not set' });

  const geo  = isInsideGeofence(parseFloat(lat), parseFloat(lng), classInfo.lat, classInfo.lng, classInfo.radius_meters||200);
  const time = isCollegeTime(classInfo.start_time, classInfo.end_time, classInfo.lunch_start, classInfo.lunch_end);

  if (!geo.inside) return res.json({ inside: false, distance: geo.distance, message: `You are ${geo.distance}m from college` });
  if (!time.isOpen) return res.json({ inside: true, message: 'Not in session' });
  if (time.isLunch) return res.json({ inside: true, message: 'Lunch time — no verify', isLunch: true });

  const lastSent   = classInfo.last_verify_sent_at ? new Date(classInfo.last_verify_sent_at) : null;
  const oneHourAgo = new Date(Date.now() - 60*60*1000);
  if (lastSent && lastSent > oneHourAgo) {
    const minsLeft = Math.round((lastSent.getTime() - oneHourAgo.getTime()) / 60000);
    return res.json({ inside: true, alreadySent: true, message: `Next verify in ${minsLeft} minutes` });
  }

  dbRun('UPDATE classes SET auto_verify_active = 1 WHERE class_code = ?', [classCode]);
  const sent = sendVerifyToClass(classCode);
  res.json({ inside: true, sent, message: `Verify sent to ${sent} students!` });
});

router.post('/send', authMiddleware, teacherOnly, (req, res) => {
  const { student_id } = req.body;
  const classCode      = req.user.class_code;
  const classInfo      = dbGet('SELECT * FROM classes WHERE class_code = ?', [classCode]);

  if (classInfo) {
    const time = isCollegeTime(classInfo.start_time, classInfo.end_time, classInfo.lunch_start, classInfo.lunch_end);
    if (time.isLunch) return res.status(400).json({ error: 'Cannot send during lunch' });
  }

  let sent = 0;
  if (student_id) {
    const session = dbGet('SELECT id FROM attendance_sessions WHERE student_id = ? AND date = ?', [student_id, today()]);
    if (session) {
      const pending = dbGet(`SELECT id FROM verify_logs WHERE student_id = ? AND session_id = ? AND result = 'pending'`, [student_id, session.id]);
      if (!pending) { dbRun(`INSERT INTO verify_logs (id, student_id, session_id, sent_at, result) VALUES (?, ?, ?, ?, 'pending')`, [uuidv4(), student_id, session.id, nowISO()]); sent = 1; }
    }
  } else { sent = sendVerifyToClass(classCode); }

  res.json({ message: `Verify sent to ${sent} students`, sent });
});

router.post('/respond', authMiddleware, (req, res) => {
  const { lat, lng } = req.body;
  const studentId    = req.user.id;
  const session = dbGet('SELECT id FROM attendance_sessions WHERE student_id = ? AND date = ?', [studentId, today()]);
  if (!session) return res.status(404).json({ error: 'No session for today' });

  const pending = dbGet(`SELECT * FROM verify_logs WHERE student_id = ? AND session_id = ? AND result = 'pending' ORDER BY sent_at DESC LIMIT 1`, [studentId, session.id]);
  if (!pending) return res.status(404).json({ error: 'No pending verification' });

  if (Date.now() - new Date(pending.sent_at).getTime() > WINDOW()) {
    dbRun(`UPDATE verify_logs SET result = 'timeout' WHERE id = ?`, [pending.id]);
    return res.status(400).json({ error: 'Verification window expired' });
  }

  if (lat && lng) {
    const user      = dbGet('SELECT class_code FROM users WHERE id = ?', [studentId]);
    const classInfo = dbGet('SELECT * FROM classes WHERE class_code = ?', [user?.class_code]);
    if (classInfo?.lat) {
      const geo = isInsideGeofence(parseFloat(lat), parseFloat(lng), classInfo.lat, classInfo.lng, classInfo.radius_meters||200);
      if (!geo.inside) {
        dbRun(`UPDATE verify_logs SET result = 'fail', lat = ?, lng = ?, responded_at = ? WHERE id = ?`, [lat, lng, nowISO(), pending.id]);
        return res.status(400).json({ error: 'Outside college — verification failed' });
      }
    }
  }

  dbRun(`UPDATE verify_logs SET result = 'pass', lat = ?, lng = ?, responded_at = ? WHERE id = ?`, [lat||null, lng||null, nowISO(), pending.id]);
  res.json({ message: 'Verification passed!', result: 'pass' });
});

router.get('/pending', authMiddleware, (req, res) => {
  const session = dbGet('SELECT id FROM attendance_sessions WHERE student_id = ? AND date = ?', [req.user.id, today()]);
  if (!session) return res.json({ pending: null });

  const pending = dbGet(`SELECT * FROM verify_logs WHERE student_id = ? AND session_id = ? AND result = 'pending' ORDER BY sent_at DESC LIMIT 1`, [req.user.id, session.id]);
  if (!pending) return res.json({ pending: null });

  const remaining = Math.max(0, WINDOW() - (Date.now() - new Date(pending.sent_at).getTime()));
  if (remaining === 0) { dbRun(`UPDATE verify_logs SET result = 'timeout' WHERE id = ?`, [pending.id]); return res.json({ pending: null }); }

  res.json({ pending: { id: pending.id, sent_at: pending.sent_at, remaining_seconds: Math.floor(remaining/1000) } });
});

module.exports = router;