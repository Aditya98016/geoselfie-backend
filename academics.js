/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 7: Homework delivery to students, submission to teacher
 */
const express  = require('express')
const multer   = require('multer')
const path     = require('path')
const { v4: uuidv4 }   = require('uuid')
const { dbGet, dbRun, dbAll } = require('./database')
const { authMiddleware, teacherOnly } = require('./middleware')
const { createClassNotification, createNotification } = require('./notifications')

const router  = express.Router()
const mkDir   = (p) => require('fs').mkdirSync(p, { recursive: true })

const hwStorage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname,'uploads/homework'); mkDir(d); cb(null,d) },
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
})
const subStorage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname,'uploads/submissions'); mkDir(d); cb(null,d) },
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
})

const hwUpload  = multer({ storage: hwStorage,  limits: { fileSize: 25*1024*1024 } })
const subUpload = multer({ storage: subStorage, limits: { fileSize: 25*1024*1024 } })

// GET /api/academics/homework
router.get('/homework', authMiddleware, (req, res) => {
  try {
    const classCode = req.user.class_code
    const role      = req.user.role

    if (role === 'teacher') {
      const homework = dbAll(
        'SELECT * FROM homework WHERE class_code=? ORDER BY created_at DESC LIMIT 50',
        [classCode]
      )
      const enriched = homework.map(hw => {
        const submissions = dbAll(
          'SELECT hs.*, u.name as student_name, u.roll_no FROM homework_submissions hs JOIN users u ON u.id=hs.student_id WHERE hs.homework_id=?',
          [hw.id]
        )
        return { ...hw, submissions, submission_count: submissions.length }
      })
      return res.json({ homework: enriched })
    }

    const homework = dbAll(
      'SELECT * FROM homework WHERE class_code=? ORDER BY created_at DESC LIMIT 50',
      [classCode]
    )
    const enriched = homework.map(hw => {
      const sub = dbGet(
        'SELECT * FROM homework_submissions WHERE homework_id=? AND student_id=?',
        [hw.id, req.user.id]
      )
      // Mark notification as read
      dbRun('UPDATE notifications SET is_read=1 WHERE user_id=? AND ref_id=? AND module=?',
        [req.user.id, hw.id, 'homework'])
      return { ...hw, my_submission: sub || null }
    })
    res.json({ homework: enriched })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/academics/homework — Teacher creates
router.post('/homework', authMiddleware, teacherOnly, hwUpload.single('file'), (req, res) => {
  try {
    const { subject, title, description, due_date } = req.body
    if (!subject?.trim() || !title?.trim())
      return res.status(400).json({ error: 'Subject and title required' })

    const classCode = req.user.class_code
    const id        = uuidv4()
    const now       = new Date().toISOString()

    let attachUrl=null, attachName=null, attachSize=null, attachMime=null
    if (req.file) {
      attachUrl  = '/uploads/homework/' + req.file.filename
      attachName = req.file.originalname
      attachSize = req.file.size
      attachMime = req.file.mimetype
    }

    dbRun(`INSERT INTO homework
      (id,class_code,teacher_id,subject,title,description,due_date,attachment_url,attachment_name,attachment_size,attachment_mime,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, classCode, req.user.id, subject.trim(), title.trim(),
       description || '', due_date || null, attachUrl, attachName, attachSize, attachMime, now])

    // FIX 7: Notify all students
    const notifTitle = '📚 New Homework: ' + title.trim()
    const notifBody  = subject.trim() + (due_date ? ' · Due: ' + due_date : '')
    createClassNotification(classCode, 'student', 'homework', notifTitle, notifBody, 'homework', id, req.user.id)

    // Socket emit
    if (global.io) {
      global.io.to('class_' + classCode).emit('new_homework', {
        id, subject: subject.trim(), title: title.trim(),
        description, due_date, attachment_url: attachUrl, attachment_name: attachName, created_at: now
      })
    }

    const hw = dbGet('SELECT * FROM homework WHERE id=?', [id])
    res.json({ success: true, homework: hw, message: 'Homework assigned to all students!' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/academics/homework/:id/submit — Student submits
router.post('/homework/:id/submit', authMiddleware, subUpload.single('file'), (req, res) => {
  try {
    const hw = dbGet('SELECT * FROM homework WHERE id=?', [req.params.id])
    if (!hw) return res.status(404).json({ error: 'Homework not found' })

    const existing = dbGet(
      'SELECT id FROM homework_submissions WHERE homework_id=? AND student_id=?',
      [req.params.id, req.user.id]
    )

    let attachUrl=null, attachName=null, attachSize=null, attachMime=null
    if (req.file) {
      attachUrl  = '/uploads/submissions/' + req.file.filename
      attachName = req.file.originalname
      attachSize = req.file.size
      attachMime = req.file.mimetype
    }

    const now = new Date().toISOString()

    if (existing) {
      dbRun(`UPDATE homework_submissions SET
        content=?, attachment_url=?, attachment_name=?, attachment_size=?, attachment_mime=?, submitted_at=?
        WHERE homework_id=? AND student_id=?`,
        [req.body.content||'', attachUrl, attachName, attachSize, attachMime, now,
         req.params.id, req.user.id])
    } else {
      dbRun(`INSERT INTO homework_submissions
        (id,homework_id,student_id,content,attachment_url,attachment_name,attachment_size,attachment_mime,submitted_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), req.params.id, req.user.id, req.body.content||'',
         attachUrl, attachName, attachSize, attachMime, now])
    }

    // FIX 7: Notify teacher
    const student = dbGet('SELECT name FROM users WHERE id=?', [req.user.id])
    const teacher = dbGet('SELECT id FROM users WHERE id=?', [hw.teacher_id])
    if (teacher) {
      createNotification(teacher.id, 'submission',
        '📝 Homework Submitted',
        (student?.name || 'Student') + ' submitted ' + hw.title,
        'homework', hw.id)
    }

    const sub = dbGet('SELECT * FROM homework_submissions WHERE homework_id=? AND student_id=?',
      [req.params.id, req.user.id])
    res.json({ success: true, submission: sub, message: 'Homework submitted!' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/academics/exams
router.get('/exams', authMiddleware, (req, res) => {
  try {
    const exams = dbAll(
      'SELECT * FROM exams WHERE class_code=? ORDER BY exam_date DESC',
      [req.user.class_code]
    )
    const enriched = exams.map(ex => {
      const myMarks = req.user.role === 'student'
        ? dbGet('SELECT * FROM marks WHERE exam_id=? AND student_id=?', [ex.id, req.user.id])
        : null
      return { ...ex, my_marks: myMarks }
    })
    res.json({ exams: enriched })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/academics/exam
router.post('/exam', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { subject, title, exam_date, total_marks=100, start_time, end_time, room } = req.body
    if (!subject?.trim() || !title?.trim()) return res.status(400).json({ error: 'Subject and title required' })

    const id  = uuidv4()
    const now = new Date().toISOString()
    dbRun(`INSERT INTO exams (id,class_code,teacher_id,subject,title,exam_date,start_time,end_time,total_marks,room,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.class_code, req.user.id, subject.trim(), title.trim(),
       exam_date||null, start_time||null, end_time||null, parseInt(total_marks)||100, room||null, now])

    // Notify students
    createClassNotification(req.user.class_code, 'student', 'exam',
      '📋 Exam Scheduled: ' + title.trim(),
      subject.trim() + (exam_date ? ' · Date: ' + exam_date : ''),
      'academics', id, req.user.id)

    const exam = dbGet('SELECT * FROM exams WHERE id=?', [id])
    res.json({ success: true, exam })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/academics/exam/:id/marks
router.post('/exam/:id/marks', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { marks_data } = req.body
    const exam = dbGet('SELECT * FROM exams WHERE id=?', [req.params.id])
    if (!exam) return res.status(404).json({ error: 'Exam not found' })

    marks_data?.forEach(m => {
      const existing = dbGet('SELECT id FROM marks WHERE exam_id=? AND student_id=?', [req.params.id, m.student_id])
      if (existing) {
        dbRun('UPDATE marks SET marks_obtained=?, grade=?, remarks=? WHERE exam_id=? AND student_id=?',
          [m.marks_obtained, m.grade||'', m.remarks||'', req.params.id, m.student_id])
      } else {
        dbRun('INSERT INTO marks (id,exam_id,student_id,marks_obtained,grade,remarks,created_at) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), req.params.id, m.student_id, m.marks_obtained, m.grade||'', m.remarks||'', new Date().toISOString()])
      }
      // Notify student
      createNotification(m.student_id, 'marks',
        '📊 Marks Added: ' + exam.title,
        'Your marks: ' + m.marks_obtained + '/' + exam.total_marks + (m.grade ? ' Grade: ' + m.grade : ''),
        'academics', req.params.id)
    })

    res.json({ success: true, count: marks_data?.length || 0 })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router