/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// POST /api/leave/request — student leave apply
router.post('/request', authMiddleware, (req, res) => {
  const { from_date, to_date, reason, type = 'sick' } = req.body;
  if (!from_date || !to_date || !reason)
    return res.status(400).json({ error: 'From date, to date and reason required' });

  const id = uuidv4();
  dbRun(`INSERT INTO leave_requests (id, student_id, from_date, to_date, reason, type, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, req.user.id, from_date, to_date, reason, type, nowISO()]);

  res.status(201).json({ message: 'Leave request submitted!', id });
});

// GET /api/leave/my-requests — student ke apne requests
router.get('/my-requests', authMiddleware, (req, res) => {
  const requests = dbAll(
    'SELECT * FROM leave_requests WHERE student_id = ? ORDER BY requested_at DESC',
    [req.user.id]
  );
  res.json({ requests });
});

// GET /api/leave/class-requests — teacher dekhe
router.get('/class-requests', authMiddleware, teacherOnly, (req, res) => {
  const requests = dbAll(`
    SELECT lr.*, u.name as student_name, u.roll_no
    FROM leave_requests lr JOIN users u ON u.id = lr.student_id
    WHERE u.class_code = ? ORDER BY lr.requested_at DESC
  `, [req.user.class_code]);
  res.json({ requests });
});

// PUT /api/leave/:id/approve — teacher approve/reject
router.put('/:id/approve', authMiddleware, teacherOnly, (req, res) => {
  const { status, teacher_note } = req.body;
  if (!['approved','rejected'].includes(status))
    return res.status(400).json({ error: 'Status must be approved or rejected' });

  dbRun(`UPDATE leave_requests SET status = ?, teacher_note = ?, resolved_at = ? WHERE id = ?`,
    [status, teacher_note||null, nowISO(), req.params.id]);

  res.json({ message: `Leave request ${status}!` });
});

// PUT /api/leave/:id/parent-approve — parent approve kare
router.put('/:id/parent-approve', authMiddleware, (req, res) => {
  const request = dbGet('SELECT * FROM leave_requests WHERE id = ?', [req.params.id]);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const student = dbGet('SELECT parent_code FROM users WHERE id = ?', [request.student_id]);
  const parent  = dbGet('SELECT unique_code FROM users WHERE id = ?', [req.user.id]);

  if (student?.parent_code !== parent?.unique_code)
    return res.status(403).json({ error: 'Not authorized as parent' });

  dbRun('UPDATE leave_requests SET parent_approved = 1 WHERE id = ?', [req.params.id]);
  res.json({ message: 'Leave approved by parent!' });
});

module.exports = router;