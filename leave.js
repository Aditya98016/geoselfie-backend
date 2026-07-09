/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Leave reason visible to teacher, attachment support
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'leave');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.pdf','.doc','.docx','.heic'];
    const ext     = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`${ext} not allowed`));
  }
});

// POST /api/leave/apply
router.post('/apply', authMiddleware, upload.single('attachment'), (req, res) => {
  try {
    // FIX: reason field properly save
    const { from_date, to_date, reason, type = 'sick' } = req.body;
    if (!from_date || !to_date || !reason?.trim())
      return res.status(400).json({ error: 'Dates and reason required' });

    const id          = uuidv4();
    const attachUrl   = req.file ? `/uploads/leave/${req.file.filename}` : null;
    const attachName  = req.file ? req.file.originalname : null;
    const attachType  = req.file ? req.file.mimetype : null;

    dbRun(`INSERT INTO leave_requests
           (id,student_id,from_date,to_date,reason,type,
            attachment_url,attachment_name,attachment_type,
            status,requested_at)
           VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
      [id, req.user.id, from_date, to_date, reason.trim(), type,
       attachUrl, attachName, attachType, nowISO()]);

    res.status(201).json({ message: 'Leave application submitted!', id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leave/my-requests
router.get('/my-requests', authMiddleware, (req, res) => {
  try {
    const requests = dbAll(
      `SELECT * FROM leave_requests WHERE student_id=? ORDER BY requested_at DESC`,
      [req.user.id]
    );
    res.json({ requests });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leave/class-requests — FIX: reason + attachment data visible
router.get('/class-requests', authMiddleware, (req, res) => {
  try {
    const requests = dbAll(`
      SELECT
        lr.*,
        u.name    as student_name,
        u.roll_no as student_roll,
        u.email   as student_email,
        u.phone   as student_phone
      FROM leave_requests lr
      JOIN users u ON u.id = lr.student_id
      WHERE u.class_code=?
      ORDER BY lr.requested_at DESC
    `, [req.user.class_code]);

    res.json({ requests });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave/:id/approve
router.put('/:id/approve', authMiddleware, (req, res) => {
  try {
    const { status, teacher_note } = req.body;
    if (!['approved','rejected'].includes(status))
      return res.status(400).json({ error: 'Status must be approved or rejected' });

    dbRun(`UPDATE leave_requests
           SET status=?, teacher_note=?, resolved_at=?
           WHERE id=?`,
      [status, teacher_note||null, nowISO(), req.params.id]);

    res.json({ message: `Leave ${status}!` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave/:id/parent-approve
router.put('/:id/parent-approve', authMiddleware, (req, res) => {
  try {
    dbRun(`UPDATE leave_requests SET parent_approved=1 WHERE id=?`, [req.params.id]);
    res.json({ message: 'Parent approved!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;