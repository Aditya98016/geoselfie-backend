/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Concurrent safety, rate limiting, all routes
 */
require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
const helmet     = require('helmet')
const rateLimit  = require('express-rate-limit')
const cron       = require('node-cron')
const http       = require('http')
const { Server } = require('socket.io')
const path       = require('path')

const { setupDatabase, dbAll, dbRun, dbGet } = require('./database')
const setupSocket = require('./socket')

const app = express()

app.set('trust proxy', 1)
const server = http.createServer(app)
const io     = new Server(server, {
  cors:          { origin: '*', methods: ['GET','POST'] },
  transports:    ['websocket','polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
})
const PORT = process.env.PORT || 5000

// ── Security ──
app.use(helmet({
  crossOriginResourcePolicy:   false,
  contentSecurityPolicy:       false,
}))
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'] }))
app.use('/api/webhook', require('./webhook'))
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true, limit: '20mb' }))

// ── Rate Limiting (concurrent protection) ──
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             1000,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests. Try again in 15 minutes.' },
  skip:            (req) => req.path === '/api/health',
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  message:  { error: 'Too many auth attempts. Try again in 15 minutes.' },
})

const pingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60, // 1 ping per second max per IP
  message:  { error: 'Location ping too frequent.' },
})

app.use('/api/', globalLimiter)
app.use('/api/auth/login',    authLimiter)
app.use('/api/auth/register', authLimiter)
app.use('/api/attendance/ping', pingLimiter)

// ── Static Files ──
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
app.use(express.static(path.join(__dirname, 'public')))

// ── Routes ──
app.use('/api/auth',          require('./auth'))
app.use('/api/attendance',    require('./attendance'))
app.use('/api/verify',        require('./verify'))
app.use('/api/teacher',       require('./teacher'))
app.use('/api/periods',       require('./periods'))
app.use('/api/qr',            require('./qr'))
app.use('/api/chat',          require('./chat'))
app.use('/api/academics',     require('./academics'))
app.use('/api/leave',         require('./leave'))
app.use('/api/notice',        require('./notice'))
app.use('/api/parent',        require('./parent'))
app.use('/api/ai',            require('./ai'))
app.use('/api/privacy',       require('./privacy'))
app.use('/api/subscription',  require('./subscription').router)
app.use('/api/accounts',      require('./accounts'))
app.use('/api/payment',       require('./payment'))
app.use('/api/admin',         require('./admin'))
app.use('/api/feedback',      require('./feedback'))
app.use('/api/sync',          require('./sync'))
app.use('/api/report-card',   require('./report_card'))
app.use('/api/verify-history',require('./verify_history'))
app.use('/api/notifications', require('./notifications').router)

// ── Browser-friendly routes ──
app.get('/privacy', (req, res) => res.redirect('/api/privacy/policy-page'))
app.get('/terms',   (req, res) => res.redirect('/api/privacy/terms'))
app.get('/',        (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html')
  if (require('fs').existsSync(indexPath)) res.sendFile(indexPath)
  else res.json({ app: 'GeoSelfie API', status: 'running', version: '3.0' })
})

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    app:    'GeoSelfie — Geo Selfie Identity',
    status: '✅ running',
    time:   new Date().toISOString(),
    memory: `${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`,
  })
})

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('Server error:', err.message)
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'File too large. Maximum 25MB.' })
  if (err.type === 'entity.too.large')
    return res.status(400).json({ error: 'Request body too large.' })
  res.status(500).json({ error: err.message || 'Internal server error' })
})

setupDatabase().then(() => {
  setupSocket(io)

  // ── CRON: Auto verify every 5 min ──
  cron.schedule('*/5 * * * *', () => {
    try {
      const { isCollegeTime } = require('./geofence')
      const now  = new Date().toISOString()
      const date = now.split('T')[0]

      const activeClasses = dbAll('SELECT * FROM classes WHERE auto_verify_active=1 AND lat IS NOT NULL', [])
      activeClasses.forEach(cls => {
        const time = isCollegeTime(cls.start_time, cls.end_time, cls.lunch_start, cls.lunch_end)
        if (!time.isOpen || time.isLunch) return

        const lastSent   = cls.last_verify_sent_at ? new Date(cls.last_verify_sent_at) : null
        const oneHourAgo = new Date(Date.now() - 60*60*1000)
        if (lastSent && lastSent > oneHourAgo) return

        const students = dbAll(`
          SELECT u.id, u.email, u.name, u.push_token
          FROM users u
          JOIN attendance_sessions s ON s.student_id=u.id
          WHERE s.date=? AND s.status='present' AND u.class_code=? AND u.role='student'
        `, [date, cls.class_code])

        let sent = 0
        students.forEach(student => {
          const session = dbGet(
            'SELECT id FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
            [student.id, date]
          )
          if (!session) return

          const pending = dbGet(
            `SELECT id FROM verify_logs WHERE student_id=? AND session_id=? AND result='pending'`,
            [student.id, session.id]
          )
          if (pending) return

          const { v4: uuidv4 } = require('uuid')
          dbRun(`INSERT INTO verify_logs (id,student_id,session_id,sent_at,result) VALUES (?,?,?,?,'pending')`,
            [uuidv4(), student.id, session.id, now])

          if (student.push_token) {
            io.to(`user_${student.id}`).emit('verify_alert', {
              period_number: 0, subject: 'General', sent_at: now,
              window_minutes: parseInt(process.env.VERIFY_WINDOW_MINUTES || 10),
            })
          }
          sent++
        })

        if (sent > 0) {
          dbRun('UPDATE classes SET last_verify_sent_at=? WHERE class_code=?', [now, cls.class_code])
          console.log(`📸 Auto verify → ${sent} students [${cls.class_code}]`)
        }
      })
    } catch(e) { console.error('CRON verify error:', e.message) }
  })

  // ── CRON: Expire pending verifications every 10 min ──
  cron.schedule('*/10 * * * *', () => {
    try {
      const window  = parseInt(process.env.VERIFY_WINDOW_MINUTES || 10)
      const cutoff  = new Date(Date.now() - window * 60 * 1000).toISOString()
      const result  = dbRun(
        `UPDATE verify_logs SET result='timeout' WHERE result='pending' AND sent_at < ?`,
        [cutoff]
      )
      if (result.changes > 0) console.log(`⏰ ${result.changes} verifications timed out`)
    } catch(e) { console.error('CRON expire error:', e.message) }
  })

  // ── CRON: Midnight reset ──
  cron.schedule('0 0 * * *', () => {
    try {
      dbRun('UPDATE classes SET auto_verify_active=0, last_verify_sent_at=NULL')
      dbRun('UPDATE users SET is_online=0')
      console.log('🔄 Daily reset done')
    } catch(e) { console.error('CRON midnight error:', e.message) }
  })

  // ── CRON: 75% warning daily 8am ──
  cron.schedule('0 8 * * *', () => {
    try {
      const students = dbAll(
        `SELECT id, name, push_token, class_code FROM users WHERE role='student' AND push_token IS NOT NULL`,
        []
      )
      students.forEach(s => {
        const days     = dbAll(`
          SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
          FROM attendance_sessions WHERE student_id=? AND period_number=0 GROUP BY date
        `, [s.id])
        const present  = days.filter(d => d.was_present).length
        const pct      = days.length > 0 ? Math.round((present/days.length)*100) : 100
        if (pct < 75 && days.length > 0) {
          io.to(`user_${s.id}`).emit('warning_75', {
            message:    `Your attendance is ${pct}%. Minimum 75% required!`,
            percentage: pct,
          })
        }
      })
    } catch(e) { console.error('CRON 75% error:', e.message) }
  })

  // ── CRON: Subscription expiry check daily 1am ──
  cron.schedule('0 1 * * *', () => {
    try {
      const result = dbRun(
        `UPDATE subscriptions SET status='expired' WHERE status='active' AND expires_at < ?`,
        [new Date().toISOString()]
      )
      if (result.changes > 0) console.log(`💳 ${result.changes} subscriptions expired`)
    } catch(e) { console.error('CRON subscription error:', e.message) }
  })

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║   GeoSelfie — Geo Selfie Identity  🚀               ║
║   © 2026 GeoSelfie — All rights reserved            ║
║   Backend:  http://localhost:${PORT}                     ║
║   Health:   http://localhost:${PORT}/api/health          ║
║   Privacy:  http://localhost:${PORT}/privacy             ║
╚══════════════════════════════════════════════════════╝
    `)
  })
}).catch(e => {
  console.error('❌ Startup failed:', e.message)
  process.exit(1)
})