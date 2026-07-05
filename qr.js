/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const express = require('express');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');
const { isInsideGeofence } = require('./geofence');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// POST /api/qr/generate — teacher QR generate karo
router.post('/generate', authMiddleware, teacherOnly, async (req, res) => {
  const { duration_minutes = 15 } = req.body;
  const classCode = req.user.class_code;
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + duration_minutes * 60 * 1000).toISOString();

  // Purane active QR deactivate karo
  dbRun('UPDATE qr_sessions SET is_active = 0 WHERE class_code = ? AND is_active = 1', [classCode]);

  const id = uuidv4();
  dbRun(`INSERT INTO qr_sessions (id, class_code, teacher_id, qr_token, expires_at, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [id, classCode, req.user.id, token, expiresAt, nowISO()]);

  // QR code image banao
  const qrData   = JSON.stringify({ token, classCode, expiresAt });
  const qrImage  = await QRCode.toDataURL(qrData);

  res.json({ token, qrImage, expiresAt, sessionId: id, durationMinutes: duration_minutes });
});

// POST /api/qr/scan — student scan karta hai
router.post('/scan', authMiddleware, async (req, res) => {
  const { token, lat, lng } = req.body;
  const studentId = req.user.id;

  if (!token) return res.status(400).json({ error: 'QR token required' });

  const qrSession = dbGet('SELECT * FROM qr_sessions WHERE qr_token = ? AND is_active = 1', [token]);
  if (!qrSession)
    return res.status(400).json({ error: 'Invalid or expired QR code' });

  if (new Date() > new Date(qrSession.expires_at))
    return res.status(400).json({ error: 'QR code has expired' });

  // Already scanned?
  const alreadyScanned = dbGet('SELECT id FROM qr_attendance WHERE qr_session_id = ? AND student_id = ?', [qrSession.id, studentId]);
  if (alreadyScanned)
    return res.status(400).json({ error: 'You have already marked attendance with this QR' });

  // Location check agar available hai
  if (lat && lng) {
    const user      = dbGet('SELECT class_code FROM users WHERE id = ?', [studentId]);
    const classInfo = dbGet('SELECT * FROM classes WHERE class_code = ?', [user?.class_code]);
    if (classInfo?.lat) {
      const geo = isInsideGeofence(parseFloat(lat), parseFloat(lng), classInfo.lat, classInfo.lng, classInfo.radius_meters||200);
      if (!geo.inside)
        return res.status(400).json({ error: `You are ${geo.distance}m from college — must be on campus` });
    }
  }

  // QR attendance log karo
  dbRun(`INSERT INTO qr_attendance (id, qr_session_id, student_id, scanned_at, lat, lng) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), qrSession.id, studentId, nowISO(), lat||null, lng||null]);

  // Session update
  dbRun('UPDATE qr_sessions SET used_count = used_count + 1 WHERE id = ?', [qrSession.id]);

  // Attendance session banao/update karo
  const date    = nowISO().split('T')[0];
  const user2   = dbGet('SELECT class_code FROM users WHERE id = ?', [studentId]);
  const session = dbGet('SELECT id FROM attendance_sessions WHERE student_id = ? AND date = ?', [studentId, date]);

  if (!session) {
    dbRun(`INSERT INTO attendance_sessions (id, student_id, class_code, date, entry_time, status, method) VALUES (?, ?, ?, ?, ?, 'present', 'qr')`,
      [uuidv4(), studentId, user2?.class_code, date, nowISO()]);
  } else {
    dbRun(`UPDATE attendance_sessions SET status = 'present', method = 'qr' WHERE id = ?`, [session.id]);
  }

  res.json({ message: 'Attendance marked via QR!', method: 'qr' });
});

// GET /api/qr/active — current active QR
router.get('/active', authMiddleware, teacherOnly, (req, res) => {
  const qr = dbGet('SELECT * FROM qr_sessions WHERE class_code = ? AND is_active = 1', [req.user.class_code]);
  if (!qr || new Date() > new Date(qr?.expires_at)) {
    if (qr) dbRun('UPDATE qr_sessions SET is_active = 0 WHERE id = ?', [qr.id]);
    return res.json({ active: null });
  }
  res.json({ active: qr });
});

module.exports = router;