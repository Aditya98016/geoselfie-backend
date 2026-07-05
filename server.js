/*
 * © 2026 GeoSelfie — Geo Selfie Identity
 * All rights reserved.
 */
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const cron       = require('node-cron');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const { setupDatabase, dbAll, dbRun, dbGet } = require('./database');
const setupSocket = require('./socket');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin:'*', methods:['GET','POST'] } });
const PORT   = process.env.PORT || 5000;

// Security
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin:'*', methods:['GET','POST','PUT','DELETE','PATCH'] }));
app.use(express.json({ limit:'20mb' }));
app.use(express.urlencoded({ extended:true, limit:'20mb' }));

// Rate limiting
const limiter     = rateLimit({ windowMs:15*60*1000, max:500, standardHeaders:true });
const authLimiter = rateLimit({ windowMs:15*60*1000, max:30 });
app.use('/api/', limiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

// Static files — uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Static website serve karo
app.use(express.static(path.join(__dirname, 'public')));

// Home route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Routes ──
app.use('/api/auth',          require('./auth'));
app.use('/api/attendance',    require('./attendance'));
app.use('/api/verify',        require('./verify'));
app.use('/api/teacher',       require('./teacher'));
app.use('/api/periods',       require('./periods'));
app.use('/api/qr',            require('./qr'));
app.use('/api/chat',          require('./chat'));
app.use('/api/academics',     require('./academics'));
app.use('/api/leave',         require('./leave'));
app.use('/api/notice',        require('./notice'));
app.use('/api/parent',        require('./parent'));
app.use('/api/ai',            require('./ai'));
app.use('/api/privacy',       require('./privacy'));
app.use('/api/subscription',  require('./subscription').router);
app.use('/api/accounts',      require('./accounts'));
app.use('/api/payment',       require('./payment'));
app.use('/api/admin',         require('./admin'));
app.use('/api/feedback',      require('./feedback'));
app.use('/api/notifications', require('./notifications').router);

// Browser-friendly redirects
app.get('/privacy', (req, res) => res.redirect('/api/privacy/policy-page'));
app.get('/terms',   (req, res) => res.redirect('/api/privacy/terms'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    app:    'GeoSelfie — Geo Selfie Identity',
    status: '✅ running',
    time:   new Date().toISOString(),
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

setupDatabase().then(() => {
  setupSocket(io);

  // ── CRON: Auto verify every 5 min ──
  cron.schedule('*/5 * * * *', () => {
    try {
      const { v4:uuidv4 }   = require('uuid');
      const { isCollegeTime } = require('./geofence');
      const now  = new Date().toISOString();
      const date = now.split('T')[0];

      const activeClasses = dbAll('SELECT * FROM classes WHERE auto_verify_active = 1 AND lat IS NOT NULL', []);
      activeClasses.forEach(cls => {
        const time = isCollegeTime(cls.start_time, cls.end_time, cls.lunch_start, cls.lunch_end);
        if (!time.isOpen || time.isLunch) return;

        const lastSent   = cls.last_verify_sent_at ? new Date(cls.last_verify_sent_at) : null;
        const oneHourAgo = new Date(Date.now() - 60*60*1000);
        if (lastSent && lastSent > oneHourAgo) return;

        const students = dbAll(`SELECT u.id, u.email, u.name, u.push_token
          FROM users u JOIN attendance_sessions s ON s.student_id = u.id
          WHERE s.date = ? AND s.status = 'present' AND u.class_code = ? AND u.role = 'student'`,
          [date, cls.class_code]);

        let sent = 0;
        students.forEach(student => {
          const session = dbGet('SELECT id FROM attendance_sessions WHERE student_id = ? AND date = ? AND period_number = 0', [student.id, date]);
          if (!session) return;
          const pending = dbGet(`SELECT id FROM verify_logs WHERE student_id = ? AND session_id = ? AND result = 'pending'`, [student.id, session.id]);
          if (pending) return;

          dbRun(`INSERT INTO verify_logs (id, student_id, session_id, sent_at, result) VALUES (?, ?, ?, ?, 'pending')`,
            [uuidv4(), student.id, session.id, now]);

          if (student.push_token) {
            const { sendPushNotification } = require('./notifications');
            sendPushNotification(student.push_token, '📸 Verify Attendance', 'Take your selfie now!', { type:'verify' });
          }
          if (student.email) {
            const { sendVerifyAlert } = require('./mailer');
            sendVerifyAlert(student.email, student.name, 'Class').catch(()=>{});
          }
          sent++;
        });

        if (sent > 0) {
          dbRun('UPDATE classes SET last_verify_sent_at = ? WHERE class_code = ?', [now, cls.class_code]);
          console.log(`📸 Auto verify → ${sent} students [${cls.class_code}]`);
        }
      });
    } catch(e) { console.error('CRON error:', e.message); }
  });

  // ── CRON: Expire verifies every 10 min ──
  cron.schedule('*/10 * * * *', () => {
    try {
      const cutoff = new Date(Date.now() - (parseInt(process.env.VERIFY_WINDOW_MINUTES||10)*60*1000)).toISOString();
      const r = dbRun(`UPDATE verify_logs SET result = 'timeout' WHERE result = 'pending' AND sent_at < ?`, [cutoff]);
      if (r.changes > 0) console.log(`⏰ ${r.changes} verifications timed out`);
    } catch(e) { console.error('CRON expire error:', e.message); }
  });

  // ── CRON: Midnight reset ──
  cron.schedule('0 0 * * *', () => {
    try {
      dbRun('UPDATE classes SET auto_verify_active = 0, last_verify_sent_at = NULL');
      dbRun('UPDATE users SET is_online = 0');
      console.log('🔄 Daily reset done');
    } catch(e) { console.error('CRON midnight error:', e.message); }
  });

  // ── CRON: 75% warning daily 8am ──
  cron.schedule('0 8 * * *', () => {
    try {
      const students = dbAll(`
        SELECT u.id, u.name, u.email, u.push_token,
          (SELECT COUNT(*) FROM attendance_sessions WHERE student_id = u.id AND status = 'present') as present_count,
          (SELECT COUNT(*) FROM attendance_sessions WHERE student_id = u.id) as total_count
        FROM users u WHERE u.role = 'student' AND u.push_token IS NOT NULL
      `, []);

      students.forEach(s => {
        const pct = s.total_count > 0 ? Math.round((s.present_count/s.total_count)*100) : 100;
        if (pct < 75 && pct > 0 && s.push_token) {
          const { sendPushNotification } = require('./notifications');
          sendPushNotification(s.push_token, '⚠️ Attendance Warning', `Your attendance is ${pct}%. Minimum 75% required.`, { type:'warning_75' });
        }
      });
    } catch(e) { console.error('CRON 75% warning error:', e.message); }
  });

  // ── CRON: Check expired subscriptions daily ──
  cron.schedule('0 1 * * *', () => {
    try {
      const expired = dbRun(`UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at < ?`, [new Date().toISOString()]);
      if (expired.changes > 0) console.log(`💳 ${expired.changes} subscriptions expired`);
    } catch(e) { console.error('CRON sub expiry error:', e.message); }
  });

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   GeoSelfie — Geo Selfie Identity  🚀            ║
║   © 2026 GeoSelfie — All rights reserved         ║
║   Backend:  http://localhost:${PORT}                  ║
║   Privacy:  http://localhost:${PORT}/privacy          ║
║   Terms:    http://localhost:${PORT}/terms            ║
║   Health:   http://localhost:${PORT}/api/health       ║
╚══════════════════════════════════════════════════╝
    `);
  });
}).catch(e => {
  console.error('❌ Failed to start:', e.message);
  process.exit(1);
});