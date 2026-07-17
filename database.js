/*
 * © 2026 GeoSelfie — Geo Selfie Identity
 * All rights reserved.
 * COMPLETE: All tables, indexes, FIX 12 schema updates
 */
const path      = require('path')
const fs        = require('fs')
const initSqlJs = require('sql.js')

let db
const DB_PATH = path.resolve('./geoselfie.db')

async function setupDatabase() {
  const SQL = await initSqlJs()

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH))
  } else {
    db = new SQL.Database()
  }

  // Auto-save every 5 seconds
  const save = () => {
    try {
      const data = db.export()
      fs.writeFileSync(DB_PATH, Buffer.from(data))
    } catch(e) { console.error('DB save error:', e.message) }
  }
  setInterval(save, 5000)

  // ── USERS ──
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    roll_no TEXT,
    class_code TEXT,
    unique_code TEXT UNIQUE,
    parent_code TEXT,
    avatar TEXT,
    is_online INTEGER DEFAULT 0,
    last_seen DATETIME,
    push_token TEXT,
    email_verified INTEGER DEFAULT 1,
    phone_verified INTEGER DEFAULT 0,
    otp_code TEXT,
    otp_expires DATETIME,
    language TEXT DEFAULT 'en',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── CLASSES ──
  db.run(`CREATE TABLE IF NOT EXISTS classes (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    class_code TEXT UNIQUE NOT NULL,
    college_name TEXT,
    address TEXT,
    lat REAL,
    lng REAL,
    radius_meters INTEGER DEFAULT 200,
    start_time TEXT DEFAULT '10:00',
    lunch_start TEXT DEFAULT '13:00',
    lunch_end TEXT DEFAULT '14:00',
    end_time TEXT DEFAULT '17:00',
    working_days TEXT DEFAULT 'mon,tue,wed,thu,fri,sat',
    auto_verify_active INTEGER DEFAULT 0,
    last_verify_sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── PERIODS ──
  db.run(`CREATE TABLE IF NOT EXISTS periods (
    id TEXT PRIMARY KEY,
    class_code TEXT NOT NULL,
    day TEXT NOT NULL,
    period_number INTEGER NOT NULL,
    subject TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    teacher_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(class_code, day, period_number)
  )`)

  // ── ATTENDANCE SESSIONS ──
  db.run(`CREATE TABLE IF NOT EXISTS attendance_sessions (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    class_code TEXT,
    date TEXT NOT NULL,
    period_id TEXT,
    period_number INTEGER DEFAULT 0,
    subject TEXT DEFAULT 'General',
    entry_time DATETIME,
    exit_time DATETIME,
    total_minutes INTEGER DEFAULT 0,
    accumulated_minutes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'absent',
    method TEXT DEFAULT 'auto',
    fake_gps_detected INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, date, period_number)
  )`)

  // ── VERIFY LOGS ──
  db.run(`CREATE TABLE IF NOT EXISTS verify_logs (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    period_id TEXT,
    period_number INTEGER DEFAULT 0,
    subject TEXT DEFAULT 'General',
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME,
    result TEXT DEFAULT 'pending',
    lat REAL,
    lng REAL,
    method TEXT DEFAULT 'selfie'
  )`)

  // ── LOCATION EVENTS ──
  db.run(`CREATE TABLE IF NOT EXISTS location_events (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    lat REAL,
    lng REAL,
    accuracy REAL,
    speed REAL,
    altitude REAL,
    is_mock INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── QR SESSIONS ──
  db.run(`CREATE TABLE IF NOT EXISTS qr_sessions (
    id TEXT PRIMARY KEY,
    class_code TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    qr_token TEXT UNIQUE NOT NULL,
    period_number INTEGER DEFAULT 0,
    subject TEXT DEFAULT 'General',
    expires_at DATETIME NOT NULL,
    used_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── QR ATTENDANCE ──
  db.run(`CREATE TABLE IF NOT EXISTS qr_attendance (
    id TEXT PRIMARY KEY,
    qr_session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    lat REAL,
    lng REAL
  )`)

  // ── CORRECTION REQUESTS ──
  db.run(`CREATE TABLE IF NOT EXISTS correction_requests (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    period_number INTEGER DEFAULT 0,
    subject TEXT DEFAULT 'General',
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    teacher_note TEXT,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`)

  // ── OFFLINE QUEUE ──
  db.run(`CREATE TABLE IF NOT EXISTS offline_queue (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    lat REAL,
    lng REAL,
    accuracy REAL,
    speed REAL,
    altitude REAL,
    timestamp DATETIME,
    synced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── CHATS ──
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'direct',
    name TEXT,
    class_code TEXT,
    created_by TEXT,
    is_broadcast INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── CHAT MEMBERS ──
  db.run(`CREATE TABLE IF NOT EXISTS chat_members (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_pinned INTEGER DEFAULT 0,
    UNIQUE(chat_id, user_id)
  )`)

  // ── MESSAGES ──
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT,
    file_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_mime TEXT,
    reply_to TEXT,
    forwarded_from TEXT,
    is_deleted INTEGER DEFAULT 0,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── MESSAGE READS ──
  db.run(`CREATE TABLE IF NOT EXISTS message_reads (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
  )`)

  // ── HOMEWORK ──
  db.run(`CREATE TABLE IF NOT EXISTS homework (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    class_code TEXT NOT NULL,
    subject TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    attachment_url TEXT,
    attachment_name TEXT,
    attachment_size INTEGER,
    attachment_mime TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── HOMEWORK SUBMISSIONS ──
  db.run(`CREATE TABLE IF NOT EXISTS homework_submissions (
    id TEXT PRIMARY KEY,
    homework_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    attachment_url TEXT,
    attachment_name TEXT,
    attachment_size INTEGER,
    attachment_mime TEXT,
    note TEXT,
    grade TEXT,
    teacher_feedback TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    graded_at DATETIME,
    UNIQUE(homework_id, student_id)
  )`)

  // ── EXAMS ──
  db.run(`CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    class_code TEXT NOT NULL,
    subject TEXT NOT NULL,
    title TEXT NOT NULL,
    exam_date TEXT,
    start_time TEXT,
    end_time TEXT,
    room TEXT,
    total_marks INTEGER DEFAULT 100,
    attachment_url TEXT,
    attachment_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── MARKS ──
  db.run(`CREATE TABLE IF NOT EXISTS marks (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    marks_obtained REAL,
    grade TEXT,
    remarks TEXT,
    entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(exam_id, student_id)
  )`)

  // ── LEAVE REQUESTS ──
  db.run(`CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    reason TEXT,
    type TEXT DEFAULT 'sick',
    attachment_url TEXT,
    attachment_name TEXT,
    status TEXT DEFAULT 'pending',
    teacher_note TEXT,
    parent_approved INTEGER DEFAULT 0,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`)

  // ── NOTICES ──
  db.run(`CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    posted_by TEXT NOT NULL,
    class_code TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    is_emergency INTEGER DEFAULT 0,
    attachment_url TEXT,
    attachment_name TEXT,
    attachment_size INTEGER,
    attachment_mime TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── NOTICE READS ──
  db.run(`CREATE TABLE IF NOT EXISTS notice_reads (
    id TEXT PRIMARY KEY,
    notice_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(notice_id, user_id)
  )`)

  // ── CONSENT LOGS ──
  db.run(`CREATE TABLE IF NOT EXISTS consent_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    consent_type TEXT NOT NULL,
    given INTEGER DEFAULT 1,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT
  )`)

  // ── DATA DELETION REQUESTS ──
  db.run(`CREATE TABLE IF NOT EXISTS data_deletion_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
  )`)

  // ── OTP LOGS ──
  db.run(`CREATE TABLE IF NOT EXISTS otp_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    contact TEXT NOT NULL,
    type TEXT NOT NULL,
    otp TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── PUSH LOGS ──
  db.run(`CREATE TABLE IF NOT EXISTS push_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT,
    body TEXT,
    type TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent'
  )`)

  // ── SUBSCRIPTIONS (FIX 1: trial_used permanent) ──
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL UNIQUE,
    plan TEXT DEFAULT 'none',
    status TEXT DEFAULT 'inactive',
    is_active INTEGER DEFAULT 0,
    trial_used INTEGER DEFAULT 0,
    started_at DATETIME,
    expires_at DATETIME,
    days_left INTEGER DEFAULT 0,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    razorpay_subscription_id TEXT,
    payment_id TEXT,
    amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'INR',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  )`)

  // ── SAVED ACCOUNTS (Multi-account switcher) ──
  db.run(`CREATE TABLE IF NOT EXISTS saved_accounts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    class_code TEXT,
    token TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#1A56DB',
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_id, user_id)
  )`)

  // ── PAYMENTS ──
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    plan TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'INR',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── INVOICES (FIX 3: Legal invoice storage) ──
  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT UNIQUE NOT NULL,
    teacher_id TEXT NOT NULL,
    class_code TEXT,
    college_name TEXT,
    teacher_name TEXT,
    teacher_email TEXT,
    plan TEXT NOT NULL,
    plan_label TEXT,
    duration_days INTEGER,
    amount REAL NOT NULL,
    tax_amount REAL DEFAULT 0,
    total_amount REAL NOT NULL,
    currency TEXT DEFAULT 'INR',
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    payment_status TEXT DEFAULT 'paid',
    invoice_date TEXT,
    valid_from DATETIME,
    valid_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── FEEDBACK ──
  db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    admin_reply TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── SUPPORT TICKETS ──
  db.run(`CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'open',
    ticket_number TEXT UNIQUE,
    admin_reply TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`)

  // ── NOTIFICATIONS (FIX 9: Badge system) ──
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    module TEXT,
    ref_id TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── REPORT CARDS ──
  db.run(`CREATE TABLE IF NOT EXISTS report_cards (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    class_code TEXT NOT NULL,
    exam_id TEXT,
    academic_year TEXT,
    term TEXT,
    generated_by TEXT,
    pdf_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── ANNOUNCEMENT LOG ──
  db.run(`CREATE TABLE IF NOT EXISTS announcement_log (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    target_class TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  // ── PERFORMANCE INDEXES ──
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_class       ON users(class_code, role)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_unique      ON users(unique_code)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_att_student_date  ON attendance_sessions(student_id, date)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_att_class_date    ON attendance_sessions(class_code, date)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_verify_student    ON verify_logs(student_id, result)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_verify_session    ON verify_logs(session_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_chat          ON messages(chat_id, sent_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_sender        ON messages(sender_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_hw_class          ON homework(class_code)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_notice_class      ON notices(class_code)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sub_teacher       ON subscriptions(teacher_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications(user_id, is_read)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_loc_student       ON location_events(student_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_leave_student     ON leave_requests(student_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_marks_exam        ON marks(exam_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_corr_student      ON correction_requests(student_id, status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_members      ON chat_members(user_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_teacher  ON payments(teacher_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_teacher  ON invoices(teacher_id)`)
  // ── AUTO MIGRATIONS ──
const migrations = [
  "ALTER TABLE leave_requests ADD COLUMN attachment_type TEXT",

  "ALTER TABLE notices ADD COLUMN teacher_id TEXT",
  "ALTER TABLE notices ADD COLUMN attachment_type TEXT",

  "ALTER TABLE homework ADD COLUMN teacher_id TEXT",
  "ALTER TABLE exams ADD COLUMN attachment_type TEXT",
]

migrations.forEach(sql => {
  try {
    db.run(sql)
    console.log("✓ Migration:", sql)
  } catch (e) {
    // Ignore if column already exists
  }
})

  save()
  console.log('✅ GeoSelfie Database ready! All tables created.')
  return { db, save }
}

function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    if (stmt.step()) {
      const row = stmt.getAsObject()
      stmt.free()
      return row
    }
    stmt.free()
    return null
  } catch(e) {
    console.error('dbGet error:', e.message, '\nSQL:', sql)
    return null
  }
}

function dbAll(sql, params = []) {
  try {
    const results = []
    const stmt    = db.prepare(sql)
    stmt.bind(params)
    while (stmt.step()) results.push(stmt.getAsObject())
    stmt.free()
    return results
  } catch(e) {
    console.error('dbAll error:', e.message, '\nSQL:', sql)
    return []
  }
}

function dbRun(sql, params = []) {
  try {
    db.run(sql, params)
    return { changes: db.getRowsModified() }
  } catch(e) {
    console.error('dbRun error:', e.message, '\nSQL:', sql)
    return { changes: 0 }
  }
}

module.exports = { setupDatabase, dbGet, dbAll, dbRun }