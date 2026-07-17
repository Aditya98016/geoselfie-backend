/*
 * © 2026 GeoSelfie — All rights reserved.
 * Admin Panel — Full user & subscription management
 */
const express = require('express');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');
const jwt = require('jsonwebtoken');

const router = express.Router();

// Super Admin middleware — sirf tumhara email
const ADMIN_EMAILS = [
  'adityarai98016@gmail.com', // ← Apna email daalo
];

function adminOnly(req, res, next) {
  if (!ADMIN_EMAILS.includes(req.user.email))
    return res.status(403).json({ error: 'Admin access only' });
  next();
}

// GET /api/admin/stats — Overall app stats
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
  const totalUsers   = dbGet('SELECT COUNT(*) as count FROM users', []);
  const teachers     = dbGet('SELECT COUNT(*) as count FROM users WHERE role = ?', ['teacher']);
  const students     = dbGet('SELECT COUNT(*) as count FROM users WHERE role = ?', ['student']);
  const parents      = dbGet('SELECT COUNT(*) as count FROM users WHERE role = ?', ['parent']);
  const activeSubsc  = dbGet('SELECT COUNT(*) as count FROM subscriptions WHERE status = ?', ['active']);
  const expiredSubsc = dbGet('SELECT COUNT(*) as count FROM subscriptions WHERE status = ?', ['expired']);
  const trialSubsc   = dbGet('SELECT COUNT(*) as count FROM subscriptions WHERE plan = ? AND status = ?', ['trial', 'active']);
  const totalRevenue = dbGet('SELECT SUM(amount) as total FROM subscriptions WHERE status = ? AND plan != ?', ['active', 'trial']);
  const todayAtt     = dbGet('SELECT COUNT(*) as count FROM attendance_sessions WHERE date = ?', [new Date().toISOString().split('T')[0]]);
  const totalClasses = dbGet('SELECT COUNT(*) as count FROM classes', []);

  res.json({
    users: {
      total:   totalUsers?.count || 0,
      teachers:teachers?.count  || 0,
      students:students?.count  || 0,
      parents: parents?.count   || 0,
    },
    subscriptions: {
      active:   activeSubsc?.count  || 0,
      expired:  expiredSubsc?.count || 0,
      trial:    trialSubsc?.count   || 0,
      revenue:  totalRevenue?.total || 0,
    },
    app: {
      total_classes:  totalClasses?.count || 0,
      today_sessions: todayAtt?.count     || 0,
    }
  });
});

// GET /api/admin/users — All users with filters
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  const { role, search, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let sql    = `SELECT u.id, u.name, u.email, u.phone, u.role, u.class_code, u.unique_code, u.email_verified, u.is_online, u.last_seen, u.created_at,
                  s.plan as sub_plan, s.status as sub_status, s.expires_at as sub_expires, s.amount as sub_amount
                FROM users u LEFT JOIN subscriptions s ON s.teacher_id = u.id WHERE 1=1`;
  const params = [];

  if (role)   { sql += ' AND u.role = ?';             params.push(role); }
  if (search) { sql += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

  const countSql = sql.replace('SELECT u.id, u.name, u.email, u.phone, u.role, u.class_code, u.unique_code, u.email_verified, u.is_online, u.last_seen, u.created_at,\n                  s.plan as sub_plan, s.status as sub_status, s.expires_at as sub_expires, s.amount as sub_amount', 'SELECT COUNT(*) as count');
  const total    = dbGet(countSql, params);

  sql += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const users = dbAll(sql, params);
  res.json({ users, total: total?.count || 0, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/user/:id — Single user detail
router.get('/user/:id', authMiddleware, adminOnly, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const subscription = dbGet('SELECT * FROM subscriptions WHERE teacher_id = ?', [req.params.id]);
  const classInfo    = dbGet('SELECT * FROM classes WHERE teacher_id = ? OR class_code = ?', [req.params.id, user.class_code]);
  const students     = user.role === 'teacher'
    ? dbAll('SELECT id, name, email, phone FROM users WHERE class_code = ? AND role = ?', [user.class_code, 'student'])
    : [];
  const attCount = dbGet('SELECT COUNT(*) as count FROM attendance_sessions WHERE student_id = ?', [req.params.id]);

  res.json({ user, subscription, classInfo, students, attendance_count: attCount?.count || 0 });
});

// PUT /api/admin/user/:id — Edit user
router.put('/user/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, email, phone, role, class_code } = req.body;
  dbRun('UPDATE users SET name = ?, email = ?, phone = ?, role = ?, class_code = ? WHERE id = ?',
    [name, email, phone, role, class_code, req.params.id]);
  res.json({ message: 'User updated!' });
});

// DELETE /api/admin/user/:id — Delete user
router.delete('/user/:id', authMiddleware, adminOnly, (req, res) => {
  const user = dbGet('SELECT role FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Delete all related data
  dbRun('DELETE FROM attendance_sessions WHERE student_id = ?', [req.params.id]);
  dbRun('DELETE FROM verify_logs WHERE student_id = ?', [req.params.id]);
  dbRun('DELETE FROM location_events WHERE student_id = ?', [req.params.id]);
  dbRun('DELETE FROM leave_requests WHERE student_id = ?', [req.params.id]);
  dbRun('DELETE FROM subscriptions WHERE teacher_id = ?', [req.params.id]);
  dbRun('DELETE FROM classes WHERE teacher_id = ?', [req.params.id]);
  dbRun('DELETE FROM saved_accounts WHERE user_id = ?', [req.params.id]);
  dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);

  res.json({ message: 'User deleted permanently' });
});

// GET /api/admin/subscriptions — All subscriptions
router.get('/subscriptions', authMiddleware, adminOnly, (req, res) => {
  const { status, page = 1 } = req.query;
  const offset = (parseInt(page) - 1) * 20;
  let sql    = `SELECT s.*, u.name as teacher_name, u.email as teacher_email, u.phone as teacher_phone,
                  (SELECT COUNT(*) FROM users WHERE class_code = u.class_code AND role = 'student') as student_count
                FROM subscriptions s JOIN users u ON u.id = s.teacher_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  sql += ' ORDER BY s.created_at DESC LIMIT 20 OFFSET ?';
  params.push(offset);
  const subs = dbAll(sql, params);
  res.json({ subscriptions: subs });
});

// PUT /api/admin/subscription/:teacherId — Manually set subscription
router.put('/subscription/:teacherId', authMiddleware, adminOnly, (req, res) => {
  const { plan, status, days } = req.body;
  const expires = new Date(Date.now() + (parseInt(days)||30) * 24*60*60*1000).toISOString();
  const existing = dbGet('SELECT id FROM subscriptions WHERE teacher_id = ?', [req.params.teacherId]);

  if (existing) {
    dbRun('UPDATE subscriptions SET plan = ?, status = ?, expires_at = ? WHERE teacher_id = ?',
      [plan||'annual', status||'active', expires, req.params.teacherId]);
  } else {
    const { v4:uuidv4 } = require('uuid');
    dbRun('INSERT INTO subscriptions (id, teacher_id, plan, status, started_at, expires_at, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      [uuidv4(), req.params.teacherId, plan||'annual', status||'active', new Date().toISOString(), expires, new Date().toISOString()]);
  }
  res.json({ message: 'Subscription updated!', expires_at: expires });
});

// POST /api/admin/subscription/:teacherId/extend — Subscription extend karo
router.post('/subscription/:teacherId/extend', authMiddleware, adminOnly, (req, res) => {
  const { days = 30 } = req.body;
  const sub    = dbGet('SELECT * FROM subscriptions WHERE teacher_id = ?', [req.params.teacherId]);
  const baseDate = (sub?.expires_at && new Date(sub.expires_at) > new Date()) ? new Date(sub.expires_at) : new Date();
  const newExpiry = new Date(baseDate.getTime() + parseInt(days)*24*60*60*1000).toISOString();

  if (sub) {
    dbRun('UPDATE subscriptions SET expires_at = ?, status = ? WHERE teacher_id = ?',
      [newExpiry, 'active', req.params.teacherId]);
  } else {
    const { v4:uuidv4 } = require('uuid');
    dbRun('INSERT INTO subscriptions (id, teacher_id, plan, status, started_at, expires_at, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      [uuidv4(), req.params.teacherId, 'manual', 'active', new Date().toISOString(), newExpiry, new Date().toISOString()]);
  }
  res.json({ message: `Extended by ${days} days`, new_expiry: newExpiry });
});

// GET /api/admin/classes — All classes
router.get('/classes', authMiddleware, adminOnly, (req, res) => {
  const classes = dbAll(`
    SELECT c.*, u.name as teacher_name, u.email as teacher_email,
      (SELECT COUNT(*) FROM users WHERE class_code = c.class_code AND role = 'student') as student_count,
      s.status as sub_status, s.plan as sub_plan, s.expires_at as sub_expires
    FROM classes c
    JOIN users u ON u.id = c.teacher_id
    LEFT JOIN subscriptions s ON s.teacher_id = c.teacher_id
    ORDER BY c.created_at DESC
  `, []);
  res.json({ classes });
});

// GET /api/admin/payments — Payment history
router.get('/payments', authMiddleware, adminOnly, (req, res) => {
  const payments = dbAll(`
    SELECT s.*, u.name as teacher_name, u.email as teacher_email
    FROM subscriptions s JOIN users u ON u.id = s.teacher_id
    WHERE s.amount > 0
    ORDER BY s.created_at DESC LIMIT 100
  `, []);
  const totalRevenue = dbGet('SELECT SUM(amount) as total FROM subscriptions WHERE amount > 0', []);
  res.json({ payments, total_revenue: totalRevenue?.total || 0 });
});

// POST /api/admin/broadcast — Send notice to all users
router.post('/broadcast', authMiddleware, adminOnly, (req, res) => {
  const { title, content, type = 'general' } = req.body;
  const { v4:uuidv4 } = require('uuid');
  const classes = dbAll('SELECT class_code FROM classes', []);

  let sent = 0;
  classes.forEach(cls => {
    dbRun('INSERT INTO notices (id, posted_by, class_code, title, content, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, cls.class_code, title, content, type, new Date().toISOString()]);
    sent++;
  });
  res.json({ message: `Broadcast sent to ${sent} classes` });
});

// GET /api/admin/login-as/:userId — Login as any user (admin only)
router.get('/login-as/:userId', authMiddleware, adminOnly, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.params.userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const token = jwt.sign(
    { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code },
    process.env.JWT_SECRET, { expiresIn:'1h' }
  );
  res.json({ token, user: { id:user.id, name:user.name, email:user.email, role:user.role } });
});

// GET /api/admin/feedback
router.get('/feedback', authMiddleware, adminOnly, (req, res) => {
  let feedback = [];
  let tickets = [];

  // Feedback table
  try {
    feedback = dbAll(
      `SELECT *
       FROM feedback
       ORDER BY created_at DESC`,
      []
    );
  } catch (e) {
    console.log('feedback table not found');
  }

  // Support tickets table
  try {
    tickets = dbAll(
      `SELECT *
       FROM support_tickets
       ORDER BY created_at DESC`,
      []
    );
  } catch (e) {
    console.log('support_tickets table not found');
  }

  res.json({
    feedback,
    tickets,
  });
});

module.exports = router;