/*
 * © 2026 GeoSelfie — All rights reserved.
 * Fix 17: Full data sync after login/reinstall
 */
const express = require('express')
const { dbGet, dbAll } = require('./database')
const { authMiddleware } = require('./middleware')
const router = express.Router()

// GET /api/sync/all — sabhi data ek request mein
router.get('/all', authMiddleware, (req, res) => {
  try {
    const userId    = req.user.id
    const role      = req.user.role
    const classCode = req.user.class_code

    const user = dbGet(
      'SELECT id,name,email,phone,role,roll_no,class_code,unique_code,parent_code,language FROM users WHERE id=?',
      [userId]
    )

    let data = { user, role, synced_at: new Date().toISOString() }

    if (role === 'student') {
      // Attendance
      const attendance = dbAll(`
        SELECT date,period_number,subject,status,total_minutes,entry_time,exit_time,method
        FROM attendance_sessions WHERE student_id=? ORDER BY date DESC LIMIT 90
      `, [userId])

      // Homework
      const homework = dbAll(`
        SELECT h.*, hs.submitted_at, hs.grade, hs.teacher_feedback
        FROM homework h
        LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=?
        WHERE h.class_code=? ORDER BY h.created_at DESC LIMIT 50
      `, [userId, classCode])

      // Exams + marks
      const exams = dbAll(`
        SELECT e.*, m.marks_obtained, m.grade, m.remarks
        FROM exams e LEFT JOIN marks m ON m.exam_id=e.id AND m.student_id=?
        WHERE e.class_code=? ORDER BY e.exam_date DESC LIMIT 30
      `, [userId, classCode])

      // Notices
      const notices = dbAll(`
        SELECT * FROM notices WHERE class_code=? ORDER BY created_at DESC LIMIT 30
      `, [classCode])

      // Leave history
      const leaves = dbAll(
        'SELECT * FROM leave_requests WHERE student_id=? ORDER BY requested_at DESC LIMIT 20',
        [userId]
      )

      // Verify logs
      const verifyLogs = dbAll(`
        SELECT vl.*, s.date FROM verify_logs vl
        JOIN attendance_sessions s ON s.id=vl.session_id
        WHERE vl.student_id=? ORDER BY vl.sent_at DESC LIMIT 60
      `, [userId])

      // Correction requests
      const corrections = dbAll(
        'SELECT * FROM correction_requests WHERE student_id=? ORDER BY requested_at DESC LIMIT 20',
        [userId]
      )

      // Today's data
      const today    = new Date().toISOString().split('T')[0]
      const todaySes = dbAll(
        'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? ORDER BY period_number',
        [userId, today]
      )

      // Attendance analytics
      const dailyAtt = dbAll(`
        SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present,
               SUM(total_minutes) as day_minutes
        FROM attendance_sessions WHERE student_id=? AND period_number=0
        GROUP BY date ORDER BY date DESC LIMIT 60
      `, [userId])

      const totalDays   = dailyAtt.length
      const presentDays = dailyAtt.filter(d => d.was_present).length
      const attPct      = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0

      data = {
        ...data,
        attendance,
        homework,
        exams,
        notices,
        leaves,
        verify_logs: verifyLogs,
        corrections,
        today_sessions: todaySes,
        analytics: {
          total_days:   totalDays,
          present_days: presentDays,
          absent_days:  totalDays - presentDays,
          percentage:   attPct,
          warning_75:   attPct < 75,
        }
      }

    } else if (role === 'teacher') {
      // Students
      const students = dbAll(
        'SELECT id,name,email,phone,roll_no,class_code,unique_code FROM users WHERE class_code=? AND role=?',
        [classCode, 'student']
      )

      // College info
      const college = dbGet('SELECT * FROM classes WHERE class_code=?', [classCode])

      // Periods
      const periods = dbAll(
        'SELECT * FROM periods WHERE class_code=? ORDER BY day,period_number',
        [classCode]
      )

      // Correction requests
      const corrections = dbAll(`
        SELECT cr.*, u.name as student_name, u.roll_no FROM correction_requests cr
        JOIN users u ON u.id=cr.student_id WHERE u.class_code=? AND cr.status='pending'
        ORDER BY cr.requested_at DESC
      `, [classCode])

      // Leave requests
      const leaves = dbAll(`
        SELECT lr.*, u.name as student_name, u.roll_no FROM leave_requests lr
        JOIN users u ON u.id=lr.student_id WHERE u.class_code=? AND lr.status='pending'
        ORDER BY lr.requested_at DESC
      `, [classCode])

      // Verify history
      const verifyHistory = dbAll(`
        SELECT vl.sent_at, vl.result, vl.period_number, vl.subject, s.date, u.name as student_name
        FROM verify_logs vl
        JOIN attendance_sessions s ON s.id=vl.session_id
        JOIN users u ON u.id=vl.student_id
        WHERE s.class_code=? ORDER BY vl.sent_at DESC LIMIT 100
      `, [classCode])

      // Today attendance
      const today    = new Date().toISOString().split('T')[0]
      const todayAtt = dbAll(`
        SELECT s.status, u.name, u.roll_no FROM attendance_sessions s
        JOIN users u ON u.id=s.student_id WHERE s.class_code=? AND s.date=? AND s.period_number=0
      `, [classCode, today])

      // Subscription
      const sub = dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [userId])

      data = {
        ...data,
        students,
        college,
        periods,
        corrections,
        leaves,
        verify_history: verifyHistory,
        today_attendance: todayAtt,
        subscription: sub,
      }

    } else if (role === 'parent') {
      const parent = dbGet('SELECT * FROM users WHERE id=?', [userId])

      // Find child
      let child = null
      if (parent?.unique_code) {
        child = dbGet('SELECT * FROM users WHERE parent_code=? AND role=?', [parent.unique_code, 'student'])
      }
      if (!child && classCode) {
        child = dbGet('SELECT * FROM users WHERE class_code=? AND role=? LIMIT 1', [classCode, 'student'])
      }

      if (child) {
        const today   = new Date().toISOString().split('T')[0]
        const todaySes = dbGet('SELECT * FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0', [child.id, today])
        const history = dbAll(`
          SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present,
                 SUM(total_minutes) as day_minutes
          FROM attendance_sessions WHERE student_id=? AND period_number=0
          GROUP BY date ORDER BY date DESC LIMIT 30
        `, [child.id])
        const presentDays = history.filter(h => h.was_present).length
        const attPct      = history.length > 0 ? Math.round((presentDays / history.length) * 100) : 0
        const homework    = dbAll(`
          SELECT h.*, hs.submitted_at, hs.grade FROM homework h
          LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=?
          WHERE h.class_code=? ORDER BY h.created_at DESC LIMIT 20
        `, [child.id, child.class_code])
        const notices = dbAll('SELECT * FROM notices WHERE class_code=? ORDER BY created_at DESC LIMIT 20', [child.class_code])

        data = {
          ...data,
          child_info: child,
          today_session: todaySes,
          attendance_history: history,
          analytics: { total_days: history.length, present_days: presentDays, percentage: attPct, warning_75: attPct < 75 },
          homework,
          notices,
        }
      } else {
        data = { ...data, child_info: null }
      }
    }

    res.json(data)
  } catch(e) {
    console.error('Sync error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router