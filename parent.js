/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
/*
 * FIX: parent_code linking corrected
 */
const express = require('express');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');
const router = express.Router();

router.get('/child-info', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'parent')
      return res.status(403).json({ error: 'Parents only' });

    const parent = dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!parent) return res.status(404).json({ error: 'Parent not found' });

    console.log('Parent lookup:', {
      parent_id: parent.id,
      parent_unique_code: parent.unique_code,
      parent_class_code: parent.class_code
    });

    let student = null;

    // FIX Method 1: student ka parent_code = parent ka unique_code
    if (parent.unique_code) {
      student = dbGet(
        'SELECT * FROM users WHERE parent_code=? AND role=?',
        [parent.unique_code, 'student']
      );
      console.log('Method 1 result:', student?.name || 'not found');
    }

    // FIX Method 2: same class_code wala student
    if (!student && parent.class_code) {
      student = dbGet(
        'SELECT * FROM users WHERE class_code=? AND role=? LIMIT 1',
        [parent.class_code, 'student']
      );
      console.log('Method 2 result:', student?.name || 'not found');
    }

    // FIX Method 3: student_unique_code from registration
if (!student && parent.parent_code) {
  student = dbGet(
    'SELECT * FROM users WHERE unique_code=? AND role=?',
    [parent.parent_code, 'student']
  );
}

    if (!student) {
      console.log('No student found for parent:', parent.id);
      return res.json({
        child: null,
        message: 'No child linked'
      });
    }

    console.log('Student found:', student.name);
console.log('Student found:', student.name);

// FIX 8: Auto update parent class_code
if (!parent.class_code && student.class_code) {
  dbRun(
    'UPDATE users SET class_code=? WHERE id=?',
    [student.class_code, parent.id]
  );
}

const today = new Date().toISOString().split('T')[0];
    const today   = new Date().toISOString().split('T')[0];
    const session = dbGet(
      'SELECT * FROM attendance_sessions WHERE student_id=? AND date=? ORDER BY period_number LIMIT 1',
      [student.id, today]
    );
    const history = dbAll(
      'SELECT date,status,total_minutes FROM attendance_sessions WHERE student_id=? ORDER BY date DESC LIMIT 30',
      [student.id]
    );
    const present = history.filter(h => h.status === 'present').length;
    const pct     = history.length ? Math.round((present / history.length) * 100) : 0;
    const leaves  = dbAll(
      'SELECT * FROM leave_requests WHERE student_id=? ORDER BY requested_at DESC LIMIT 10',
      [student.id]
    );
    const notices = student.class_code ? dbAll(
      'SELECT title,type,is_emergency,created_at FROM notices WHERE class_code=? ORDER BY created_at DESC LIMIT 10',
      [student.class_code]
    ) : [];

    res.json({
      child: {
        id: student.id, name: student.name, email: student.email,
        phone: student.phone, roll_no: student.roll_no,
        class_code: student.class_code, unique_code: student.unique_code
      },
      today: { session: session || null, status: session?.status || 'absent' },
      attendance: { total: history.length, present, percentage: pct, warning: pct < 75 },
      leave_requests: leaves,
      notices
    });
  } catch(e) {
    console.error('child-info error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/homework-status', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'parent')
      return res.status(403).json({ error: 'Parents only' });

    const parent  = dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
    let student   = null;

    if (parent?.unique_code) {
      student = dbGet('SELECT * FROM users WHERE parent_code=? AND role=?', [parent.unique_code, 'student']);
    }
    if (!student && parent?.class_code) {
      student = dbGet('SELECT * FROM users WHERE class_code=? AND role=? LIMIT 1', [parent.class_code, 'student']);
    }

    // FIX 8: Method 3
if (!student && parent?.parent_code) {
  student = dbGet(
    'SELECT * FROM users WHERE unique_code=? AND role=?',
    [parent.parent_code, 'student']
  );
}

    if (!student) return res.json({ homework: [] });

    const { dbAll: dbAllLocal } = require('./database');
    const homework = dbAll(`
      SELECT h.*, hs.submitted_at, hs.grade
      FROM homework h
      LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=?
      WHERE h.class_code=?
      ORDER BY h.created_at DESC LIMIT 20
    `, [student.id, student.class_code]);

    res.json({ homework });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;