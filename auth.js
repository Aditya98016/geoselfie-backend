/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: email_verified default 1, OTP console fallback
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');
const { generateOTP, sendOTPEmail } = require('./mailer');
const { createTrialSubscription } = require('./subscription');

const router = express.Router();

function generateClassCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GS-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateUniqueCode(prefix) {
  const num = Math.floor(10000000 + Math.random() * 90000000);
  return `${prefix}-${num}`;
}

// POST /api/auth/register
// register route mein yeh changes karo:
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role='student',
      roll_no, class_code, student_unique_code, language='en',
      start_time, lunch_start, lunch_end, end_time } = req.body

    // FIX 12: Validate first — before any DB queries
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' })
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' })
    if (!password)      return res.status(400).json({ error: 'Password required' })
    if (!phone?.trim()) return res.status(400).json({ error: 'Mobile number required' })

    const emailLower = email.trim().toLowerCase()
    const phoneClean = phone.replace(/[\s\-+]/g, '')

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower))
      return res.status(400).json({ error: 'Invalid email address' })

    if (!/^[6-9]\d{9}$/.test(phoneClean))
      return res.status(400).json({ error: 'Invalid Indian mobile number' })

    // FIX 12: Single combined duplicate check
    const existing = dbGet(
      'SELECT id, email, phone FROM users WHERE email=? OR phone=?',
      [emailLower, phoneClean]
    )
    if (existing?.email === emailLower) return res.status(400).json({ error: 'Email already registered' })
    if (existing?.phone === phoneClean) return res.status(400).json({ error: 'Mobile already registered' })

    // Role-specific validation
    let finalClassCode = null, teacherClassCode = null
    let uniqueCode = null, parentCodeStore = null

    if (role === 'student') {
      if (!class_code) return res.status(400).json({ error: 'Class code required' })
      const cls = dbGet('SELECT class_code FROM classes WHERE class_code=?', [class_code.toUpperCase()])
      if (!cls)   return res.status(400).json({ error: 'Invalid class code' })
      finalClassCode = class_code.toUpperCase()
      uniqueCode     = generateUniqueCode('STU')
    } else if (role === 'parent') {
      if (!student_unique_code) return res.status(400).json({ error: 'Student code required' })
      const stu = dbGet('SELECT class_code FROM users WHERE unique_code=?', [student_unique_code])
      if (!stu)   return res.status(400).json({ error: 'Invalid student code' })
      finalClassCode  = stu.class_code
      uniqueCode      = generateUniqueCode('PAR')
      parentCodeStore = student_unique_code // FIX 8: store for linking
    } else if (role === 'teacher') {
      uniqueCode = generateUniqueCode('TCH')
    }

    // FIX 12: Hash + generate in parallel
    const [hashed] = await Promise.all([
      bcrypt.hash(password, 8), // FIX 12: rounds 10→8 for speed
    ])

    const id  = uuidv4()
    const now = new Date().toISOString()

    if (role === 'teacher') {
      let code
      do { code = generateClassCode() }
      while (dbGet('SELECT id FROM classes WHERE class_code=?', [code]))
      teacherClassCode = code
      finalClassCode   = code

      // FIX 12: Single transaction for teacher + class insert
      dbRun(`INSERT INTO users
             (id,name,email,phone,password,role,roll_no,class_code,unique_code,parent_code,language,email_verified,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        [id, name.trim(), emailLower, phoneClean, hashed, role, roll_no||null,
         finalClassCode, uniqueCode, null, language, now])

      dbRun(`INSERT INTO classes
             (id,teacher_id,class_code,start_time,lunch_start,lunch_end,end_time,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
        [uuidv4(), id, teacherClassCode,
         start_time||'10:00', lunch_start||'13:00', lunch_end||'14:00', end_time||'17:00', now])

      // Trial subscription (non-blocking)
      try { createTrialSubscription(id) } catch {}

    } else {
      dbRun(`INSERT INTO users
             (id,name,email,phone,password,role,roll_no,class_code,unique_code,parent_code,language,email_verified,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        [id, name.trim(), emailLower, phoneClean, hashed, role, roll_no||null,
         finalClassCode, uniqueCode, role === 'parent' ? parentCodeStore : null, language, now])
    }

    // FIX 12: Generate token immediately
    const token = jwt.sign(
      { id, name:name.trim(), email:emailLower, role, class_code:finalClassCode },
      process.env.JWT_SECRET, { expiresIn:'30d' }
    )

    res.status(201).json({
      message:     'Registration successful!',
      token,
      otp_required:false,
      user: {
  id,
  name: name.trim(),
  email: emailLower,
  phone: phoneClean,
  role,
  roll_no: roll_no || null,
  class_code: finalClassCode,
  unique_code: uniqueCode,
  parent_code: role === 'parent' ? parentCodeStore : null,
  email_verified: 1,
  language,
},
      ...(role==='teacher' ? { class_code_display:teacherClassCode } : {})
    })
  } catch(e) {
    console.error('Register error:', e.message)
    res.status(500).json({ error: 'Registration failed: ' + e.message })
  }
})

// POST /api/auth/verify-otp
router.post('/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = dbGet('SELECT * FROM users WHERE email = ?', [email?.trim().toLowerCase()]);
    if (!user) return res.status(400).json({ error: 'User not found' });

    if (user.email_verified) return res.json({ message: 'Email already verified!', already_verified: true });

    if (user.otp_code !== otp?.trim())
      return res.status(400).json({ error: 'Invalid OTP. Check your email or server console.' });

    if (new Date() > new Date(user.otp_expires))
      return res.status(400).json({ error: 'OTP expired — request a new one' });

    dbRun('UPDATE users SET email_verified = 1, otp_code = NULL, otp_expires = NULL WHERE id = ?', [user.id]);
    res.json({ message: 'Email verified successfully! You can now login.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const user      = dbGet('SELECT * FROM users WHERE email = ?', [email?.trim().toLowerCase()]);
    if (!user) return res.status(400).json({ error: 'User not found' });

    const otp     = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    dbRun('UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?', [otp, expires, user.id]);

    console.log(`\n🔑 Resend OTP for ${email}: ${otp}\n`);
    await sendOTPEmail(email.trim(), otp, user.name);

    res.json({
      message: 'OTP resent!',
      otp: process.env.EMAIL_USER === 'your_gmail@gmail.com' ? otp : undefined
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, unique_code } = req.body;
    let user;

    if (unique_code) {
      user = dbGet('SELECT * FROM users WHERE unique_code = ?', [unique_code.trim()]);
      if (!user) return res.status(400).json({ error: 'Invalid unique code' });
      if (password) {
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Invalid password' });
      }
    } else {
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
      user = dbGet('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
      if (!user) return res.status(400).json({ error: 'Invalid email or password' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(400).json({ error: 'Invalid email or password' });
    }

    dbRun('UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?', [new Date().toISOString(), user.id]);

    const token = jwt.sign(
      { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id:user.id, name:user.name, email:user.email, phone:user.phone,
        role:user.role, roll_no:user.roll_no, class_code:user.class_code,
        unique_code:user.unique_code, parent_code:user.parent_code,
        email_verified:user.email_verified, language:user.language||'en',
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const user = dbGet(
    'SELECT id,name,email,phone,role,roll_no,class_code,unique_code,parent_code,avatar,is_online,email_verified,language FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// PUT /api/auth/update-profile
router.put('/update-profile', authMiddleware, async (req, res) => {
  const { name, phone, push_token, language } = req.body;
  dbRun('UPDATE users SET name=?, phone=?, push_token=?, language=? WHERE id=?',
    [name||req.user.name, phone||null, push_token||null, language||'en', req.user.id]);
  res.json({ message: 'Profile updated!' });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, (req, res) => {
  dbRun('UPDATE users SET is_online=0, last_seen=? WHERE id=?', [new Date().toISOString(), req.user.id]);
  res.json({ message: 'Logged out' });
});

module.exports = router;