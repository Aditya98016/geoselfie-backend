/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Verify sirf aaj ke day ka period check karega
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');
const { sendVerifyAlert } = require('./mailer');

const router = express.Router();
const DAYS   = ['mon','tue','wed','thu','fri','sat'];
const DAY_LABELS = {
  mon:'Monday', tue:'Tuesday', wed:'Wednesday',
  thu:'Thursday', fri:'Friday', sat:'Saturday', sun:'Sunday'
};

// CRITICAL FIX — yahan bug tha
function getTodayDayName() {
  // new Date() India time mein lena chahiye
  const now  = new Date();
  // IST = UTC + 5:30
  const ist  = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  console.log(`📅 Today (IST): ${days[ist.getUTCDay()]} — ${ist.toISOString()}`);
  return days[ist.getUTCDay()];
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = (t||'00:00').split(':').map(Number);
  return h * 60 + m;
}

router.post('/setup', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { periods } = req.body;
    const classCode   = req.user.class_code;
    if (!periods || !Array.isArray(periods))
      return res.status(400).json({ error: 'Periods array required' });

    let created = 0, updated = 0;
    periods.forEach(p => {
      if (!DAYS.includes(p.day)) return;
      if (!p.subject?.trim()) return;
      const existing = dbGet(
        'SELECT id FROM periods WHERE class_code=? AND day=? AND period_number=?',
        [classCode, p.day, p.period_number]
      );
      if (existing) {
        dbRun('UPDATE periods SET subject=?, start_time=?, end_time=? WHERE id=?',
          [p.subject, p.start_time, p.end_time, existing.id]);
        updated++;
      } else {
        dbRun(`INSERT INTO periods
               (id,class_code,day,period_number,subject,start_time,end_time,teacher_id,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), classCode, p.day, p.period_number,
           p.subject, p.start_time, p.end_time,
           req.user.id, new Date().toISOString()]);
        created++;
      }
    });
    res.json({ message:`${created} created, ${updated} updated`, created, updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/list', authMiddleware, (req, res) => {
  try {
    const periods = dbAll(
      'SELECT * FROM periods WHERE class_code=? ORDER BY day, period_number',
      [req.user.class_code]
    );
    const grouped = {};
    DAYS.forEach(d => { grouped[d] = []; });
    periods.forEach(p => { if (grouped[p.day]) grouped[p.day].push(p); });
    res.json({ periods, grouped, days: DAYS, day_labels: DAY_LABELS });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FIX: Sirf aaj ka real day IST mein
router.get('/today', authMiddleware, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const today     = getTodayDayName();

    if (today === 'sun') {
      return res.json({
        periods: [], day: today,
        day_label: 'Sunday',
        message: 'No classes on Sunday'
      });
    }

    const periods = dbAll(
      'SELECT * FROM periods WHERE class_code=? AND day=? ORDER BY period_number',
      [classCode, today]
    );

    console.log(`📅 Returning periods for ${today} (${DAY_LABELS[today]}): ${periods.length} periods`);

    res.json({ periods, day: today, day_label: DAY_LABELS[today] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/send-verify', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { period_id, period_number, subject } = req.body;
    const classCode = req.user.class_code;
    const today     = getTodayDayName();
    const date      = new Date().toISOString().split('T')[0];
    const now       = new Date().toISOString();

    if (period_id) {
      const periodCheck = dbGet('SELECT * FROM periods WHERE id=?', [period_id]);
      if (periodCheck && periodCheck.day !== today) {
        return res.status(400).json({
          error: `Period is for ${DAY_LABELS[periodCheck.day]}, but today is ${DAY_LABELS[today]}`
        });
      }
    }

    const students = dbAll(
      `SELECT u.id, u.email, u.name, u.push_token
       FROM users u WHERE u.class_code=? AND u.role='student'`,
      [classCode]
    );

    let sent = 0;
    students.forEach(student => {
      let session = dbGet(
        'SELECT id FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
        [student.id, date, period_number||0]
      );
      if (!session) {
        const sid = uuidv4();
        dbRun(`INSERT INTO attendance_sessions
               (id,student_id,class_code,date,period_id,period_number,subject,status,method,created_at)
               VALUES (?,?,?,?,?,?,?,'present','auto',?)`,
          [sid, student.id, classCode, date,
           period_id||null, period_number||0, subject||'General', now]);
        session = { id: sid };
      }
      const pending = dbGet(
        `SELECT id FROM verify_logs WHERE student_id=? AND session_id=? AND result='pending'`,
        [student.id, session.id]
      );
      if (pending) return;

      dbRun(`INSERT INTO verify_logs
             (id,student_id,session_id,period_id,period_number,subject,sent_at,result)
             VALUES (?,?,?,?,?,?,?,'pending')`,
        [uuidv4(), student.id, session.id,
         period_id||null, period_number||0, subject||'General', now]);

      if (student.email) {
        sendVerifyAlert(student.email, student.name, subject||'General').catch(()=>{});
      }
      sent++;
    });

    dbRun('UPDATE classes SET last_verify_sent_at=? WHERE class_code=?', [now, classCode]);
    res.json({ message:`Verify sent to ${sent} students`, sent, today, day_label: DAY_LABELS[today] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/attendance-summary', authMiddleware, (req, res) => {
  try {
    const classCode  = req.user.class_code;
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];
    const students   = dbAll('SELECT id,name,roll_no FROM users WHERE role=? AND class_code=? ORDER BY name', ['student',classCode]);
    const sessions   = dbAll('SELECT * FROM attendance_sessions WHERE class_code=? AND date=? ORDER BY period_number', [classCode,targetDate]);
    const periods    = dbAll('SELECT * FROM periods WHERE class_code=? ORDER BY day,period_number', [classCode]);
    const summary    = students.map(s => {
      const ss  = sessions.filter(x => x.student_id === s.id);
      const pm  = {};
      ss.forEach(x => { pm[x.period_number] = x.status; });
      return { ...s, periods: pm, present_periods: ss.filter(x=>x.status==='present').length, total_periods: ss.length };
    });
    res.json({ summary, date: targetDate, periods });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;