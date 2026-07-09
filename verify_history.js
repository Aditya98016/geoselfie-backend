/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Every verification creates NEW history — nothing overwritten
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();

// GET /api/verify-history/list — Teacher ki verification history
router.get('/list', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code;

    // FIX: verify_logs se group by session, unique history
    const history = dbAll(`
      SELECT
        vl.id,
        vl.sent_at,
        vl.result,
        vl.period_number,
        vl.subject,
        s.date,
        p.start_time as period_start,
        p.end_time as period_end,
        u.name as student_name,
        u.roll_no,
        u.email as student_email
      FROM verify_logs vl
      JOIN attendance_sessions s ON s.id = vl.session_id
      JOIN users u ON u.id = vl.student_id
      LEFT JOIN periods p ON p.id = vl.period_id
      WHERE s.class_code=?
      ORDER BY vl.sent_at DESC
      LIMIT 500
    `, [classCode]);

    // Group by sent_at (same minute = same batch)
    const grouped = {};
    history.forEach(row => {
      // batch key = minute-level grouping
      const batchKey = row.sent_at?.slice(0, 16) + '_' + (row.period_number || 0);
      if (!grouped[batchKey]) {
        grouped[batchKey] = {
          batch_key:    batchKey,
          date:         row.date,
          sent_at:      row.sent_at,
          period_number:row.period_number,
          subject:      row.subject,
          period_start: row.period_start,
          period_end:   row.period_end,
          teacher_name: req.user.name,
          verified:     [],
          absent:       [],
          total:        0,
        };
      }
      grouped[batchKey].total++;
      if (row.result === 'verified') {
        grouped[batchKey].verified.push({ name: row.student_name, roll: row.roll_no });
      } else {
        grouped[batchKey].absent.push({ name: row.student_name, roll: row.roll_no, result: row.result });
      }
    });

    const sessions = Object.values(grouped).sort((a,b) => new Date(b.sent_at) - new Date(a.sent_at));
    res.json({ sessions, total: sessions.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/verify-history/student/:studentId
router.get('/student/:studentId', authMiddleware, (req, res) => {
  try {
    const logs = dbAll(`
      SELECT vl.*, p.start_time as period_start, p.end_time as period_end,
             u.name as teacher_name
      FROM verify_logs vl
      LEFT JOIN periods p ON p.id = vl.period_id
      LEFT JOIN attendance_sessions s ON s.id = vl.session_id
      LEFT JOIN classes c ON c.class_code = s.class_code
      LEFT JOIN users u ON u.id = c.teacher_id
      WHERE vl.student_id=?
      ORDER BY vl.sent_at DESC LIMIT 100
    `, [req.params.studentId]);
    res.json({ logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;