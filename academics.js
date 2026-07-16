/*
 * © 2026 GeoSelfie — All rights reserved.
 * Academics — Homework + Exams + Marks + Report Card
 */
const express = require('express')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const { v4: uuidv4 } = require('uuid')
const { dbGet, dbRun, dbAll } = require('./database')
const { authMiddleware, teacherOnly } = require('./middleware')
const { createNotification, createClassNotification } = require('./notifications')

const router  = express.Router()
const nowISO  = () => new Date().toISOString()

const storage = multer.diskStorage({
  destination: (req, file, cb) => { const d=path.join(__dirname,'uploads','academics'); fs.mkdirSync(d,{recursive:true}); cb(null,d) },
  filename:    (req, file, cb) => cb(null, uuidv4()+path.extname(file.originalname).toLowerCase())
})
const upload = multer({ storage, limits:{ fileSize:25*1024*1024 }, fileFilter:(req,file,cb)=>{
  const ok = ['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.jpg','.jpeg','.png','.txt','.zip']
  if (ok.includes(path.extname(file.originalname).toLowerCase())) cb(null,true)
  else cb(new Error('File type not allowed'))
}})

// ── HOMEWORK ──

router.post('/homework', authMiddleware, teacherOnly, upload.single('file'), (req, res) => {
  try {
    const { subject, title, description, due_date } = req.body
    if (!subject?.trim()||!title?.trim()) return res.status(400).json({ error:'Subject and title required' })

    const id  = uuidv4()
    const now = nowISO()
    const attachUrl  = req.file ? `/uploads/academics/${req.file.filename}` : null
    const attachName = req.file ? req.file.originalname : null
    const attachSize = req.file ? req.file.size : null
    const attachMime = req.file ? req.file.mimetype : null

    dbRun(`INSERT INTO homework (id,teacher_id,class_code,subject,title,description,due_date,attachment_url,attachment_name,attachment_size,attachment_mime,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, req.user.class_code, subject, title, description||null, due_date||null, attachUrl, attachName, attachSize, attachMime, now])

    createClassNotification(req.user.class_code, 'student', 'homework',
      `📚 New Homework: ${title}`, `${subject}${due_date?` · Due: ${due_date}`:''}`, 'homework', id, req.user.id)

    if (global.io) {
      global.io.to('class_'+req.user.class_code).emit('new_homework', { id, subject, title, due_date, attachment_url:attachUrl, created_at:now })
    }

    res.status(201).json({ message:'Homework assigned!', id, attachment_url:attachUrl })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.get('/homework', authMiddleware, (req, res) => {
  try {
    const homework = dbAll(`SELECT h.*,u.name as teacher_name,
      (SELECT COUNT(*) FROM homework_submissions WHERE homework_id=h.id) as submission_count
      FROM homework h JOIN users u ON u.id=h.teacher_id
      WHERE h.class_code=? ORDER BY h.created_at DESC`, [req.user.class_code])

    if (req.user.role === 'student') {
      const enriched = homework.map(hw => {
        const sub = dbGet('SELECT * FROM homework_submissions WHERE homework_id=? AND student_id=?', [hw.id, req.user.id])
        dbRun('UPDATE notifications SET is_read=1 WHERE user_id=? AND ref_id=? AND module=?', [req.user.id, hw.id, 'homework'])
        return { ...hw, my_submission:sub||null }
      })
      return res.json({ homework:enriched })
    }
    res.json({ homework })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/homework/:id/submit', authMiddleware, upload.single('file'), (req, res) => {
  try {
    const hw = dbGet('SELECT * FROM homework WHERE id=?', [req.params.id])
    if (!hw) return res.status(404).json({ error:'Homework not found' })

    const attachUrl  = req.file ? `/uploads/academics/${req.file.filename}` : null
    const attachName = req.file ? req.file.originalname : null
    const attachSize = req.file ? req.file.size : null
    const attachMime = req.file ? req.file.mimetype : null
    const now        = nowISO()

    const existing = dbGet('SELECT id FROM homework_submissions WHERE homework_id=? AND student_id=?', [req.params.id, req.user.id])
    if (existing) {
      dbRun('UPDATE homework_submissions SET attachment_url=?,attachment_name=?,attachment_size=?,attachment_mime=?,note=?,submitted_at=? WHERE id=?',
        [attachUrl, attachName, attachSize, attachMime, req.body.note||null, now, existing.id])
    } else {
      dbRun(`INSERT INTO homework_submissions (id,homework_id,student_id,attachment_url,attachment_name,attachment_size,attachment_mime,note,submitted_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), req.params.id, req.user.id, attachUrl, attachName, attachSize, attachMime, req.body.note||null, now])
    }

    // Notify teacher
    const student = dbGet('SELECT name FROM users WHERE id=?', [req.user.id])
    createNotification(hw.teacher_id, 'submission', '📝 Homework Submitted',
      `${student?.name||'Student'} submitted ${hw.title}`, 'homework', hw.id)

    const sub = dbGet('SELECT * FROM homework_submissions WHERE homework_id=? AND student_id=?', [req.params.id, req.user.id])
    res.json({ message:'Homework submitted!', submission:sub })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.put('/homework/:id/grade', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { student_id, grade, feedback } = req.body
    dbRun('UPDATE homework_submissions SET grade=?,teacher_feedback=?,graded_at=? WHERE homework_id=? AND student_id=?',
      [grade, feedback||null, nowISO(), req.params.id, student_id])
    const hw = dbGet('SELECT title FROM homework WHERE id=?', [req.params.id])
    createNotification(student_id, 'grade', '📊 Homework Graded',
      `Grade ${grade} for ${hw?.title||'homework'}`, 'homework', req.params.id)
    res.json({ message:'Grade saved!' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.delete('/homework/:id', authMiddleware, teacherOnly, (req, res) => {
  try {
    dbRun('DELETE FROM homework WHERE id=? AND teacher_id=?', [req.params.id, req.user.id])
    res.json({ message:'Homework deleted' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── EXAMS ──

router.post('/exam', authMiddleware, teacherOnly, upload.single('attachment'), (req, res) => {
  try {
    const { subject, title, exam_date, start_time, end_time, room, total_marks=100 } = req.body
    if (!subject?.trim()||!title?.trim()) return res.status(400).json({ error:'Subject and title required' })

    const id         = uuidv4()
    const attachUrl  = req.file ? `/uploads/academics/${req.file.filename}` : null
    const attachName = req.file ? req.file.originalname : null

    dbRun(`INSERT INTO exams (id,teacher_id,class_code,subject,title,exam_date,start_time,end_time,room,total_marks,attachment_url,attachment_name,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, req.user.class_code, subject, title, exam_date||null, start_time||null, end_time||null, room||null, parseInt(total_marks)||100, attachUrl, attachName, nowISO()])

    createClassNotification(req.user.class_code, 'student', 'exam',
      `📋 Exam: ${title}`, `${subject}${exam_date?` · Date: ${exam_date}`:''}`, 'academics', id, req.user.id)

    res.status(201).json({ message:'Exam scheduled!', id, attachment_url:attachUrl })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.get('/exams', authMiddleware, (req, res) => {
  try {
    const exams = dbAll(`SELECT e.*,u.name as teacher_name FROM exams e JOIN users u ON u.id=e.teacher_id WHERE e.class_code=? ORDER BY e.exam_date ASC`, [req.user.class_code])
    if (req.user.role === 'student') {
      const enriched = exams.map(ex => {
        const mark = dbGet('SELECT * FROM marks WHERE exam_id=? AND student_id=?', [ex.id, req.user.id])
        return { ...ex, my_marks:mark||null }
      })
      return res.json({ exams:enriched })
    }
    if (req.user.role === 'teacher') {
      const enriched = exams.map(ex => {
        const markedCount = dbGet('SELECT COUNT(*) as c FROM marks WHERE exam_id=?', [ex.id])
        const students    = dbAll('SELECT u.id,u.name,u.roll_no,m.marks_obtained,m.grade FROM users u LEFT JOIN marks m ON m.exam_id=? AND m.student_id=u.id WHERE u.class_code=? AND u.role=? ORDER BY u.name', [ex.id, req.user.class_code,'student'])
        return { ...ex, marked_count:markedCount?.c||0, students }
      })
      return res.json({ exams:enriched })
    }
    res.json({ exams })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/exam/:id/marks', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { marks_data } = req.body
    if (!marks_data?.length) return res.status(400).json({ error:'marks_data array required' })
    const exam = dbGet('SELECT * FROM exams WHERE id=?', [req.params.id])
    if (!exam) return res.status(404).json({ error:'Exam not found' })

    let updated = 0
    marks_data.forEach(m => {
      const existing = dbGet('SELECT id FROM marks WHERE exam_id=? AND student_id=?', [req.params.id, m.student_id])
      if (existing) {
        dbRun('UPDATE marks SET marks_obtained=?,grade=?,remarks=? WHERE id=?',
          [m.marks_obtained, m.grade||null, m.remarks||null, existing.id])
      } else {
        dbRun('INSERT INTO marks (id,exam_id,student_id,marks_obtained,grade,remarks,entered_at) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), req.params.id, m.student_id, m.marks_obtained, m.grade||null, m.remarks||null, nowISO()])
      }
      createNotification(m.student_id, 'marks', '📊 Marks Added',
        `${exam.title}: ${m.marks_obtained}/${exam.total_marks}${m.grade?` · Grade: ${m.grade}`:''}`, 'academics', req.params.id)
      updated++
    })
    res.json({ message:`${updated} marks saved!` })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.delete('/exam/:id', authMiddleware, teacherOnly, (req, res) => {
  try {
    dbRun('DELETE FROM exams WHERE id=? AND teacher_id=?', [req.params.id, req.user.id])
    res.json({ message:'Exam deleted' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── REPORT CARD ──

router.get('/report-card/:studentId', authMiddleware, (req, res) => {
  try {
    const student = dbGet('SELECT id,name,roll_no,class_code FROM users WHERE id=?', [req.params.studentId])
    if (!student) return res.status(404).json({ error:'Student not found' })

    const marks      = dbAll('SELECT m.*,e.subject,e.title,e.exam_date,e.total_marks FROM marks m JOIN exams e ON e.id=m.exam_id WHERE m.student_id=? ORDER BY e.exam_date DESC', [req.params.studentId])
    const attendance = dbAll('SELECT status FROM attendance_sessions WHERE student_id=? AND period_number=0', [req.params.studentId])
    const present    = attendance.filter(a=>a.status==='present').length
    const pct        = attendance.length ? Math.round((present/attendance.length)*100) : 0
    const avgMarks   = marks.length ? marks.reduce((s,m)=>s+(m.marks_obtained/m.total_marks*100),0)/marks.length : 0

    function getGrade(p) {
      if (p>=90) return 'A+'; if (p>=80) return 'A'; if (p>=70) return 'B'
      if (p>=60) return 'C'; if (p>=50) return 'D'; return 'F'
    }

    res.json({
      student,
      marks,
      attendance: { total:attendance.length, present, percentage:pct },
      summary:    { avg_percentage:Math.round(avgMarks), grade:getGrade(avgMarks), attendance_pct:pct }
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router