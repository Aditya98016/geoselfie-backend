/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 7: Notice delivery to students and parents
 */
const express  = require('express')
const multer   = require('multer')
const path     = require('path')
const { v4: uuidv4 }   = require('uuid')
const { dbGet, dbRun, dbAll } = require('./database')
const { authMiddleware, teacherOnly } = require('./middleware')
const { createClassNotification } = require('./notifications')

const router  = express.Router()
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads/notices')
    require('fs').mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname))
  }
})
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } })

// GET /api/notice/list
router.get('/list', authMiddleware, (req, res) => {
  try {
    const classCode = req.user.class_code
    const notices   = dbAll(
      'SELECT * FROM notices WHERE class_code=? ORDER BY created_at DESC LIMIT 50',
      [classCode]
    )

    // Mark as read for this user
    const now = new Date().toISOString()
    notices.forEach(n => {
      const exists = dbGet('SELECT id FROM notice_reads WHERE notice_id=? AND user_id=?', [n.id, req.user.id])
      if (!exists) {
        dbRun('INSERT INTO notice_reads (id,notice_id,user_id,read_at) VALUES (?,?,?,?)',
          [uuidv4(), n.id, req.user.id, now])
        // Mark notification as read
        dbRun('UPDATE notifications SET is_read=1 WHERE user_id=? AND ref_id=? AND module=?',
          [req.user.id, n.id, 'notice'])
      }
    })

    res.json({ notices })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/notice/create
router.post('/create', authMiddleware, teacherOnly, upload.single('attachment'), (req, res) => {
  try {
    const { title, content, type = 'general', is_emergency = false } = req.body
    if (!title?.trim() || !content?.trim())
      return res.status(400).json({ error: 'Title and content required' })

    const classCode = req.user.class_code
    const id        = uuidv4()
    const now       = new Date().toISOString()

    let attachUrl  = null
    let attachName = null
    let attachSize = null
    let attachMime = null

    if (req.file) {
      attachUrl  = '/uploads/notices/' + req.file.filename
      attachName = req.file.originalname
      attachSize = req.file.size
      attachMime = req.file.mimetype
    }

   dbRun(`INSERT INTO notices
(id,posted_by,class_code,title,content,type,is_emergency,
attachment_url,attachment_name,attachment_size,attachment_mime,created_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
[
  id,
  req.user.id,
  classCode,
  title.trim(),
  content.trim(),
  type,
  is_emergency ? 1 : 0,
  attachUrl,
  attachName,
  attachSize,
  attachMime,
  now
])

    // FIX 7: Notify all students
    const notifTitle = (is_emergency ? '🚨 EMERGENCY: ' : '📢 ') + title.trim()
    const notifBody  = content.trim().slice(0, 100)

    createClassNotification(classCode, 'student', 'notice', notifTitle, notifBody, 'notice', id, req.user.id)

    // FIX 7: Notify parents whose children are in this class
    const students = dbAll('SELECT id FROM users WHERE class_code=? AND role=?', [classCode, 'student'])
    students.forEach(stu => {
      const parent = dbGet('SELECT id FROM users WHERE parent_code=? AND role=?', [stu.id, 'parent'])
        || dbGet('SELECT id FROM users WHERE unique_code=(SELECT parent_code FROM users WHERE id=?) AND role=?', [stu.id, 'parent'])
      if (parent) {
        const { createNotification } = require('./notifications')
        createNotification(parent.id, 'notice', notifTitle, notifBody, 'notice', id)
      }
    })

    // Socket broadcast to class
    if (global.io) {
      global.io.to('class_' + classCode).emit('new_notice', {
        id, title: title.trim(), content: content.trim(), type,
        is_emergency: is_emergency ? 1 : 0,
        attachment_url: attachUrl, attachment_name: attachName,
        created_at: now,
      })
    }

    const notice = dbGet('SELECT * FROM notices WHERE id=?', [id])
    res.json({ success: true, notice, message: 'Notice posted and delivered!' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router