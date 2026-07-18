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
const { createClassNotification, findParentForStudent } = require('./notifications')

const router  = express.Router()

// NEW: Parents have no class_code of their own — resolve their linked
// child's class_code so GET /list actually returns notices for them.
// (Previously this silently returned an empty list for every parent.)
function resolveClassCode(user) {
  if (user.role !== 'parent') return user.class_code
  const child =
    dbGet('SELECT class_code FROM users WHERE unique_code=? AND role=?', [user.parent_code, 'student']) ||
    dbGet(
      `SELECT class_code FROM users WHERE role='student' AND id IN (
         SELECT id FROM users WHERE parent_code=(SELECT unique_code FROM users WHERE id=?)
       )`, [user.id]
    )
  return child ? child.class_code : user.class_code
}
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
    const classCode = resolveClassCode(req.user)
    const notices   = dbAll(
      'SELECT * FROM notices WHERE class_code=? ORDER BY created_at DESC LIMIT 50',
      [classCode]
    )

    // FIX (Section 1): "is_unread" now reflects this user's own live
    // notification state instead of being force-marked read the moment
    // the notice list is fetched. The badge for a specific notice only
    // clears once the user actually opens THAT notice — see
    // POST /notice/:id/open below.
    const withFlags = notices.map(n => {
      const notifUnread = dbGet(
        'SELECT id FROM notifications WHERE user_id=? AND module=? AND ref_id=? AND is_read=0',
        [req.user.id, 'notice', n.id]
      )
      const alreadyOpened = dbGet('SELECT id FROM notice_reads WHERE notice_id=? AND user_id=?', [n.id, req.user.id])
      return { ...n, is_unread: !!notifUnread, is_opened: !!alreadyOpened }
    })

    res.json({ notices: withFlags })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/notice/:id/open
// FIX (Section 1): Mark ONE notice as opened/read for the current user
// — called when they actually open that specific notice.
router.post('/:id/open', authMiddleware, (req, res) => {
  try {
    const exists = dbGet('SELECT id FROM notice_reads WHERE notice_id=? AND user_id=?', [req.params.id, req.user.id])
    if (!exists) {
      dbRun('INSERT INTO notice_reads (id,notice_id,user_id,read_at) VALUES (?,?,?,?)',
        [uuidv4(), req.params.id, req.user.id, new Date().toISOString()])
    }
    dbRun('UPDATE notifications SET is_read=1 WHERE user_id=? AND ref_id=? AND module=?',
      [req.user.id, req.params.id, 'notice'])
    res.json({ success: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/notice/create
router.post('/create', authMiddleware, teacherOnly, upload.single('attachment'), (req, res) => {
  try {
    console.log('===== NOTICE REQUEST =====')
console.log('BODY:', req.body)
console.log('FILE:', req.file)
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

  console.log('===== NOTICE FILE =====')
  console.log(req.file)
  console.log('Attachment URL:', attachUrl)
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

const saved = dbGet(
  'SELECT attachment_url, attachment_name FROM notices WHERE id=?',
  [id]
)

console.log('Saved notice:', saved)

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
