/*
 * © 2026 GeoSelfie — Geo Selfie Identity
 * All rights reserved.
 */
const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');

let db;
const DB_PATH = path.resolve('./geoselfie.db');

async function setupDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  const save = () => {
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch(e) { console.error('DB save error:', e.message); }
  };
  setInterval(save, 5000);

  // Users
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
  );`);

  // Classes
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
  );`);

  // Periods
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
  );`);

  // Attendance Sessions
 // attendance_sessions table mein add karo
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
  accumulated_minutes INTEGER DEFAULT 0,  -- FIX: exit ke baad accumulate hota hai
  status TEXT DEFAULT 'absent',
  method TEXT DEFAULT 'auto',
  fake_gps_detected INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(student_id, date, period_number)
);`);

  // Verify Logs
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
  );`);

  // Location Events
  db.run(`CREATE TABLE IF NOT EXISTS location_events (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    lat REAL,
    lng REAL,
    accuracy REAL,
    is_mock INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // QR Sessions
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
  );`);

  // QR Attendance
  db.run(`CREATE TABLE IF NOT EXISTS qr_attendance (
    id TEXT PRIMARY KEY,
    qr_session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    lat REAL,
    lng REAL
  );`);

  // Correction Requests
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
  );`);

  // Offline Queue
  db.run(`CREATE TABLE IF NOT EXISTS offline_queue (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    lat REAL,
    lng REAL,
    timestamp DATETIME,
    synced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Chats
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'direct',
    name TEXT,
    class_code TEXT,
    created_by TEXT,
    is_broadcast INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Chat Members
  db.run(`CREATE TABLE IF NOT EXISTS chat_members (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_pinned INTEGER DEFAULT 0,
    UNIQUE(chat_id, user_id)
  );`);

  // Messages
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT,
    file_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    reply_to TEXT,
    forwarded_from TEXT,
    is_deleted INTEGER DEFAULT 0,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Message Reads
  db.run(`CREATE TABLE IF NOT EXISTS message_reads (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
  );`);

  // Homework
  db.run(`CREATE TABLE IF NOT EXISTS homework (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    class_code TEXT NOT NULL,
    subject TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Homework Submissions
  db.run(`CREATE TABLE IF NOT EXISTS homework_submissions (
    id TEXT PRIMARY KEY,
    homework_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    note TEXT,
    grade TEXT,
    teacher_feedback TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(homework_id, student_id)
  );`);

  // Exams
  db.run(`CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    class_code TEXT NOT NULL,
    subject TEXT NOT NULL,
    title TEXT NOT NULL,
    exam_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    room TEXT,
    total_marks INTEGER DEFAULT 100,
    attachment_url TEXT,
    attachment_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Marks
  db.run(`CREATE TABLE IF NOT EXISTS marks (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    marks_obtained REAL,
    grade TEXT,
    remarks TEXT,
    entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(exam_id, student_id)
  );`);

  // Leave Requests
  db.run(`CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    type TEXT DEFAULT 'sick',
    attachment_url TEXT,
    status TEXT DEFAULT 'pending',
    teacher_note TEXT,
    parent_approved INTEGER DEFAULT 0,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );`);

  // Notices
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
    attachment_type TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Consent Logs
  db.run(`CREATE TABLE IF NOT EXISTS consent_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    consent_type TEXT NOT NULL,
    given INTEGER DEFAULT 1,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT
  );`);

  // Data Deletion Requests
  db.run(`CREATE TABLE IF NOT EXISTS data_deletion_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
  );`);

  // OTP Logs
  db.run(`CREATE TABLE IF NOT EXISTS otp_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    contact TEXT NOT NULL,
    type TEXT NOT NULL,
    otp TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Push Notification Logs
  db.run(`CREATE TABLE IF NOT EXISTS push_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT,
    body TEXT,
    type TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent'
  );`);

  // Subscriptions
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL UNIQUE,
    plan TEXT DEFAULT 'trial',
    status TEXT DEFAULT 'active',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    trial_used INTEGER DEFAULT 1,
    payment_id TEXT,
    amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'INR',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Saved Accounts
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
  );`);

  // Payments
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    plan TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  // Feedback
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
  );`);

  // Support Tickets
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
  );`);

  // FIX: Performance indexes
db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date
        ON attendance_sessions(student_id, date)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_class_date
        ON attendance_sessions(class_code, date)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_verify_student
        ON verify_logs(student_id, result)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_users_class
        ON users(class_code, role)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat
        ON messages(chat_id, sent_at)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_homework_class
        ON homework(class_code)`)

  save();
  console.log('✅ GeoSelfie Database ready!');
  return { db, save };
}

function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
    stmt.free(); return null;
  } catch(e) { console.error('dbGet error:', e.message, sql); return null; }
}

function dbAll(sql, params = []) {
  try {
    const results = [];
    const stmt    = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free(); return results;
  } catch(e) { console.error('dbAll error:', e.message); return []; }
}

function dbRun(sql, params = []) {
  try { db.run(sql, params); return { changes: db.getRowsModified() }; }
  catch(e) { console.error('dbRun error:', e.message); return { changes: 0 }; }
}

module.exports = { setupDatabase, dbGet, dbAll, dbRun };