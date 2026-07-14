/*
 * © 2026 GeoSelfie — All rights reserved.
 * OTP removed — direct registration
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');
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

// POST /api/auth/register — OTP nahi, seedha account banta hai
router.post('/register', async (req, res) => {
  try {
    const {
      name, email, phone, password,
      role = 'student', roll_no,
      class_code, start_time, lunch_start, lunch_end, end_time,
      student_unique_code, language = 'en'
    } = req.body;

    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });

    if (!phone?.trim())
      return res.status(400).json({ error: 'Mobile number is required' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim()))
      return res.status(400).json({ error: 'Invalid email address' });

    const phoneClean = phone.replace(/[\s\-+]/g, '');
    if (!/^[6-9]\d{9}$/.test(phoneClean))
      return res.status(400).json({ error: 'Invalid Indian mobile number' });

    if (role === 'student') {
      if (!class_code)
        return res.status(400).json({ error: 'Class code required for students' });
      const cls = dbGet('SELECT id FROM classes WHERE class_code=?', [class_code.toUpperCase()]);
      if (!cls)
        return res.status(400).json({ error: 'Invalid class code — get it from your teacher' });
    }

    if (role === 'parent') {
      if (!student_unique_code)
        return res.status(400).json({ error: 'Student unique code required for parents' });
      const stu = dbGet('SELECT id FROM users WHERE unique_code=?', [student_unique_code]);
      if (!stu)
        return res.status(400).json({ error: 'Invalid student code' });
    }

   const emailLower = email.trim().toLowerCase();

const existing = dbGet(
  'SELECT id,email,phone FROM users WHERE email=? OR phone=?',
  [emailLower, phoneClean]
);

if (existing?.email === emailLower)
  return res.status(400).json({ error: 'Email already registered' });

if (existing?.phone === phoneClean)
  return res.status(400).json({ error: 'Mobile already registered' });

const [hashed] = await Promise.all([
  bcrypt.hash(password, 8)
]);
    const id     = uuidv4();
    const now    = new Date().toISOString();

   let uniqueCode = null;
let parentCodeStore = null;
let finalClassCode = null;
let teacherClassCode = null;

    if (role === 'teacher') {
      let code;
      do { code = generateClassCode(); }
      while (dbGet('SELECT id FROM classes WHERE class_code=?', [code]));

      uniqueCode = generateUniqueCode('TCH');
      dbRun(`INSERT INTO classes
             (id,teacher_id,class_code,start_time,lunch_start,lunch_end,end_time,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
        [uuidv4(), id, code,
         start_time||'10:00', lunch_start||'13:00',
         lunch_end||'14:00', end_time||'17:00', now]);
      finalClassCode = code;

   } else if (role === 'student') {
  finalClassCode = class_code.toUpperCase();
  uniqueCode = generateUniqueCode('STU');
  parentCodeStore = generateUniqueCode('PAR');

   } else if (role === 'parent') {
  if (!student_unique_code)
    return res.status(400).json({ error: 'Student unique code required' });

  const stu = dbGet(
    'SELECT class_code FROM users WHERE unique_code=?',
    [student_unique_code]
  );

  if (!stu)
    return res.status(400).json({ error: 'Invalid student code' });

  finalClassCode = stu.class_code;
  uniqueCode = generateUniqueCode('PAR');

  // Parent ko student se link karega
  parentCodeStore = student_unique_code;
}

    // email_verified = 1 seedha — OTP nahi chahiye
    dbRun(`INSERT INTO users
           (id,name,email,phone,password,role,roll_no,class_code,
            unique_code,parent_code,language,email_verified,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [id, name.trim(), emailLower, phoneClean, hashed,
       role, roll_no||null, finalClassCode,
       uniqueCode, // insert
parentCodeStore || null, language, now]);

    if (role === 'teacher') {
      try { createTrialSubscription(id); } catch(e) { console.error('Trial sub error:', e.message); }
    }

    const token = jwt.sign(
      { id, name:name.trim(), email:emailLower, role, class_code:finalClassCode },
      process.env.JWT_SECRET, { expiresIn:'30d' }
    );

    res.status(201).json({
      message: role === 'teacher'
        ? `Registration successful! Your class code is: ${finalClassCode}`
        : 'Registration successful!',
      token,
      otp_required: false, // OTP nahi chahiye
      user: {
        id, name:name.trim(), email:emailLower, phone:phoneClean,
        role, roll_no, class_code:finalClassCode,
        unique_code:uniqueCode,parent_code: parentCodeStore || null,
        email_verified: 1
      },
      ...(role === 'teacher' ? { class_code_display: finalClassCode } : {})
    });

  } catch(e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Registration failed: ' + e.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, unique_code } = req.body;
    let user;

    if (unique_code) {
      user = dbGet('SELECT * FROM users WHERE unique_code=?', [unique_code.trim()]);
      if (!user) return res.status(400).json({ error: 'Invalid unique code' });
      if (password) {
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Invalid password' });
      }
    } else {
      if (!email || !password)
        return res.status(400).json({ error: 'Email and password required' });
      user = dbGet('SELECT * FROM users WHERE email=?', [email.trim().toLowerCase()]);
      if (!user) return res.status(400).json({ error: 'Invalid email or password' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(400).json({ error: 'Invalid email or password' });
    }

    dbRun('UPDATE users SET is_online=1, last_seen=? WHERE id=?',
      [new Date().toISOString(), user.id]);

    const token = jwt.sign(
      { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code },
      process.env.JWT_SECRET, { expiresIn:'30d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id:user.id, name:user.name, email:user.email, phone:user.phone,
        role:user.role, roll_no:user.roll_no, class_code:user.class_code,
        unique_code:user.unique_code, parent_code:user.parent_code,
        email_verified:1, language:user.language||'en'
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const user = dbGet(
    'SELECT id,name,email,phone,role,roll_no,class_code,unique_code,parent_code,avatar,is_online,email_verified,language FROM users WHERE id=?',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// PUT /api/auth/update-profile
router.put('/update-profile', authMiddleware, async (req, res) => {
  const { name, phone, push_token, language } = req.body;
  dbRun('UPDATE users SET name=?,phone=?,push_token=?,language=? WHERE id=?',
    [name||req.user.name, phone||null, push_token||null, language||'en', req.user.id]);
  res.json({ message: 'Profile updated!' });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, (req, res) => {
  dbRun('UPDATE users SET is_online=0, last_seen=? WHERE id=?',
    [new Date().toISOString(), req.user.id]);
  res.json({ message: 'Logged out' });
});

// Yeh routes ab kuch nahi karte — backward compatibility ke liye rakh rahe hain
router.post('/verify-otp', (req, res) => res.json({ message: 'Email already verified', already_verified: true }));
router.post('/resend-otp',  (req, res) => res.json({ message: 'OTP system disabled' }));

module.exports = router;