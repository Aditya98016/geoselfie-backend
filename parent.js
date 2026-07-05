/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const express = require('express');
const { dbGet, dbAll } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();

// GET /api/parent/child-info — apne bachche ki info
router.get('/child-info', authMiddleware, (req, res) => {
  if (req.user.role !== 'parent')
    return res.status(403).json({ error: 'Parents only' });

  const parent  = dbGet('SELECT unique_code FROM users WHERE id = ?', [req.user.id]);
  const student = dbGet('SELECT id, name, roll_no, class_code, unique_code FROM users WHERE parent_code = ?', [parent?.unique_code]);

  if (!student) return res.status(404).json({ error: 'No child linked to this account' });

  const today    = new Date().toISOString().split('T')[0];
  const session  = dbGet('SELECT * FROM attendance_sessions WHERE student_id = ? AND date = ?', [student.id, today]);
  const history  = dbAll('SELECT date, status, total_minutes FROM attendance_sessions WHERE student_id = ? ORDER BY date DESC LIMIT 30', [student.id]);
  const present  = history.filter(h => h.status === 'present').length;
  const pct      = history.length ? Math.round((present/history.length)*100) : 0;

  const leaves   = dbAll('SELECT * FROM leave_requests WHERE student_id = ? ORDER BY requested_at DESC LIMIT 10', [student.id]);
  const notices  = dbAll('SELECT title, type, is_emergency, created_at FROM notices WHERE class_code = ? ORDER BY created_at DESC LIMIT 10', [student.class_code]);

  res.json({
    child: student,
    today: { session, status: session?.status || 'absent' },
    attendance: { total: history.length, present, percentage: pct, warning: pct < 75 },
    leave_requests: leaves,
    notices
  });
});

// GET /api/parent/homework-status — bachche ki homework status
router.get('/homework-status', authMiddleware, (req, res) => {
  if (req.user.role !== 'parent')
    return res.status(403).json({ error: 'Parents only' });

  const parent  = dbGet('SELECT unique_code FROM users WHERE id = ?', [req.user.id]);
  const student = dbGet('SELECT id, class_code FROM users WHERE parent_code = ?', [parent?.unique_code]);
  if (!student)  return res.status(404).json({ error: 'No child linked' });

  const homework = dbAll(`
    SELECT h.*, hs.submitted_at, hs.grade
    FROM homework h
    LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
    WHERE h.class_code = ? ORDER BY h.created_at DESC LIMIT 20
  `, [student.id, student.class_code]);

  res.json({ homework });
});

module.exports = router;