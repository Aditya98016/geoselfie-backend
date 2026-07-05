/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: PDF + file upload working for homework, exams, submissions
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

// File upload setup — accepts PDF, images, docs
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'academics');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.jpg','.jpeg','.png','.txt','.zip'];
  const ext     = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error(`File type ${ext} not allowed`));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ── HOMEWORK ──

router.post('/homework', authMiddleware, teacherOnly, upload.single('file'), (req, res) => {
  try {
    const { subject, title, description, due_date } = req.body;
    if (!subject?.trim() || !title?.trim())
      return res.status(400).json({ error: 'Subject and title required' });

    const id       = uuidv4();
    const fileUrl  = req.file ? `/uploads/academics/${req.file.filename}` : null;
    const fileName = req.file ? req.file.originalname : null;
    const fileType = req.file ? req.file.mimetype : null;

    dbRun(`INSERT INTO homework (id, teacher_id, class_code, subject, title, description, due_date, file_url, file_name, file_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, req.user.class_code, subject, title, description||null, due_date||null, fileUrl, fileName, fileType, nowISO()]);

    res.status(201).json({ message: 'Homework created!', id, file_url: fileUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/homework', authMiddleware, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const homeworks = dbAll(`
      SELECT h.*, u.name as teacher_name,
        (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id) as submission_count
      FROM homework h JOIN users u ON u.id = h.teacher_id
      WHERE h.class_code = ? ORDER BY h.created_at DESC
    `, [classCode]);

    if (req.user.role === 'student') {
      const enriched = homeworks.map(hw => {
        const sub = dbGet('SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ?', [hw.id, req.user.id]);
        return { ...hw, my_submission: sub||null };
      });
      return res.json({ homework: enriched });
    }
    res.json({ homework: homeworks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/homework/:id/submit', authMiddleware, upload.single('file'), (req, res) => {
  try {
    const { note } = req.body;
    const fileUrl  = req.file ? `/uploads/academics/${req.file.filename}` : null;
    const fileName = req.file ? req.file.originalname : null;
    const fileType = req.file ? req.file.mimetype : null;

    const existing = dbGet('SELECT id FROM homework_submissions WHERE homework_id = ? AND student_id = ?', [req.params.id, req.user.id]);
    if (existing) {
      dbRun('UPDATE homework_submissions SET file_url=?, file_name=?, file_type=?, note=?, submitted_at=? WHERE id=?',
        [fileUrl, fileName, fileType, note||null, nowISO(), existing.id]);
    } else {
      dbRun(`INSERT INTO homework_submissions (id, homework_id, student_id, file_url, file_name, file_type, note, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.params.id, req.user.id, fileUrl, fileName, fileType, note||null, nowISO()]);
    }
    res.json({ message: 'Homework submitted!', file_url: fileUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/homework/:id/grade', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { student_id, grade, feedback } = req.body;
    dbRun('UPDATE homework_submissions SET grade=?, teacher_feedback=? WHERE homework_id=? AND student_id=?',
      [grade, feedback||null, req.params.id, student_id]);
    res.json({ message: 'Grade updated!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/homework/:id', authMiddleware, teacherOnly, (req, res) => {
  try {
    dbRun('DELETE FROM homework WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Homework deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXAMS ──

router.post('/exam', authMiddleware, teacherOnly, upload.single('attachment'), (req, res) => {
  try {
    const { subject, title, exam_date, start_time, end_time, room, total_marks } = req.body;
    if (!subject?.trim() || !title?.trim() || !exam_date)
      return res.status(400).json({ error: 'Subject, title, and date required' });

    const id         = uuidv4();
    const attachUrl  = req.file ? `/uploads/academics/${req.file.filename}` : null;
    const attachName = req.file ? req.file.originalname : null;

    dbRun(`INSERT INTO exams (id, teacher_id, class_code, subject, title, exam_date, start_time, end_time, room, total_marks, attachment_url, attachment_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, req.user.class_code, subject, title, exam_date, start_time||null, end_time||null, room||null, total_marks||100, attachUrl, attachName, nowISO()]);

    res.status(201).json({ message: 'Exam scheduled!', id, attachment_url: attachUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/exams', authMiddleware, (req, res) => {
  try {
    const exams = dbAll(`SELECT e.*, u.name as teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id WHERE e.class_code = ? ORDER BY e.exam_date ASC`, [req.user.class_code]);
    if (req.user.role === 'student') {
      const enriched = exams.map(exam => {
        const mark = dbGet('SELECT * FROM marks WHERE exam_id = ? AND student_id = ?', [exam.id, req.user.id]);
        return { ...exam, my_marks: mark||null };
      });
      return res.json({ exams: enriched });
    }
    res.json({ exams });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/exam/:id/marks', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { marks_data } = req.body;
    if (!marks_data || !Array.isArray(marks_data))
      return res.status(400).json({ error: 'marks_data array required' });

    let updated = 0;
    marks_data.forEach(m => {
      const existing = dbGet('SELECT id FROM marks WHERE exam_id = ? AND student_id = ?', [req.params.id, m.student_id]);
      if (existing) {
        dbRun('UPDATE marks SET marks_obtained=?, grade=?, remarks=? WHERE id=?',
          [m.marks_obtained, m.grade||null, m.remarks||null, existing.id]);
      } else {
        dbRun('INSERT INTO marks (id, exam_id, student_id, marks_obtained, grade, remarks, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [uuidv4(), req.params.id, m.student_id, m.marks_obtained, m.grade||null, m.remarks||null, nowISO()]);
      }
      updated++;
    });
    res.json({ message: `${updated} marks updated!` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/report-card/:studentId', authMiddleware, (req, res) => {
  try {
    const student    = dbGet('SELECT id,name,roll_no,class_code FROM users WHERE id = ?', [req.params.studentId]);
    if (!student)    return res.status(404).json({ error: 'Student not found' });
    const marks      = dbAll('SELECT m.*, e.subject, e.title, e.exam_date, e.total_marks FROM marks m JOIN exams e ON e.id = m.exam_id WHERE m.student_id = ? ORDER BY e.exam_date DESC', [req.params.studentId]);
    const attendance = dbAll('SELECT status FROM attendance_sessions WHERE student_id = ?', [req.params.studentId]);
    const present    = attendance.filter(a=>a.status==='present').length;
    const pct        = attendance.length ? Math.round((present/attendance.length)*100) : 0;
    const avgMarks   = marks.length ? marks.reduce((s,m)=>s+(m.marks_obtained/m.total_marks*100),0)/marks.length : 0;

    function getGrade(p) {
      if (p>=90) return 'A+'; if (p>=80) return 'A'; if (p>=70) return 'B';
      if (p>=60) return 'C'; if (p>=50) return 'D'; return 'F';
    }

    res.json({
      student,
      marks,
      attendance: { total:attendance.length, present, percentage:pct },
      summary:    { avg_percentage:Math.round(avgMarks), grade:getGrade(avgMarks), attendance_pct:pct }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;