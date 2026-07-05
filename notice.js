/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: PDF + file attachment in notices
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'notices');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.jpg','.jpeg','.png','.doc','.docx'];
    const ext     = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`${ext} not allowed`));
  }
});

router.post('/create', authMiddleware, teacherOnly, upload.single('attachment'), (req, res) => {
  try {
    const { title, content, type = 'general', is_emergency = false, expires_at } = req.body;
    if (!title?.trim() || !content?.trim())
      return res.status(400).json({ error: 'Title and content required' });

    const id          = uuidv4();
    const attachUrl   = req.file ? `/uploads/notices/${req.file.filename}` : null;
    const attachName  = req.file ? req.file.originalname : null;
    const attachType  = req.file ? req.file.mimetype : null;

    dbRun(`INSERT INTO notices (id, posted_by, class_code, title, content, type, is_emergency, attachment_url, attachment_name, attachment_type, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, req.user.class_code, title.trim(), content.trim(), type, is_emergency?1:0, attachUrl, attachName, attachType, expires_at||null, nowISO()]);

    if (global.io) {
      global.io.to(`class_${req.user.class_code}`).emit('new_notice', { id, title, type, is_emergency });
    }

    res.status(201).json({ message: 'Notice posted!', id, attachment_url: attachUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/list', authMiddleware, (req, res) => {
  try {
    const notices = dbAll(`
      SELECT n.*, u.name as posted_by_name
      FROM notices n JOIN users u ON u.id = n.posted_by
      WHERE n.class_code = ? AND (n.expires_at IS NULL OR n.expires_at > ?)
      ORDER BY n.is_emergency DESC, n.created_at DESC LIMIT 50
    `, [req.user.class_code, nowISO()]);
    res.json({ notices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', authMiddleware, teacherOnly, (req, res) => {
  try {
    dbRun('DELETE FROM notices WHERE id = ? AND posted_by = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Notice deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;