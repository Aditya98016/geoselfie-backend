/*
 * © 2026 GeoSelfie — All rights reserved.
 */
const express = require('express');
const XLSX    = require('xlsx');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();
const today  = () => new Date().toISOString().split('T')[0];

async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { headers: { 'Accept-Language':'en', 'User-Agent':'GeoSelfie/1.0' } });
    const data = await res.json();
    return data.display_name || null;
  } catch { return null; }
}

// GET /api/teacher/dashboard
router.get('/dashboard', authMiddleware, teacherOnly, (req, res) => {
  const date      = today();
  const classCode = req.user.class_code;
  const classInfo = dbGet('SELECT * FROM classes WHERE class_code = ?', [classCode]);

  const students = dbAll(`
    SELECT u.id, u.name, u.email, u.phone, u.roll_no, u.is_online, u.last_seen, u.unique_code, u.parent_code
    FROM users u WHERE u.role = 'student' AND u.class_code = ? ORDER BY u.name ASC
  `, [classCode]);

  const withStats = students.map(s => {
    const sessions = dbAll('SELECT * FROM attendance_sessions WHERE student_id = ? AND date = ? ORDER BY period_number', [s.id, date]);
    const history  = dbAll('SELECT status FROM attendance_sessions WHERE student_id = ? ORDER BY date DESC LIMIT 30', [s.id]);
    const present  = history.filter(h=>h.status==='present').length;
    const attPct   = history.length ? Math.round((present/history.length)*100) : 0;
    const verifyLogs = dbAll('SELECT result FROM verify_logs WHERE student_id = ?', [s.id]);
    const pass     = verifyLogs.filter(l=>l.result==='pass').length;
    const fail     = verifyLogs.filter(l=>l.result==='fail'||l.result==='timeout').length;

    return {
      ...s,
      today_sessions: sessions,
      present_periods: sessions.filter(ss=>ss.status==='present').length,
      total_periods: sessions.length,
      overall_attendance_pct: attPct,
      warning_75: attPct < 75 && attPct > 0,
      verify_pass: pass, verify_fail: fail,
      flag: fail > 0 ? 'suspicious' : (sessions.some(ss=>ss.status==='present') ? 'ok' : 'absent')
    };
  });

  res.json({
    date, classCode, classInfo,
    summary: {
      total: students.length,
      present: withStats.filter(s=>s.present_periods>0).length,
      absent:  withStats.filter(s=>s.present_periods===0).length,
      suspicious: withStats.filter(s=>s.verify_fail>0).length,
      warning_75: withStats.filter(s=>s.warning_75).length
    },
    students: withStats
  });
});

// POST /api/teacher/setup-college
router.post('/setup-college', authMiddleware, teacherOnly, async (req, res) => {
  const { name, lat, lng, radius, start_time, lunch_start, lunch_end, end_time, address: provided } = req.body;
  const classCode = req.user.class_code;
  if (!lat || !lng) return res.status(400).json({ error: 'Location required' });
  if (!name)        return res.status(400).json({ error: 'College name required' });

  let address = provided || await reverseGeocode(lat, lng);
  dbRun(`UPDATE classes SET college_name=?, address=?, lat=?, lng=?, radius_meters=?, start_time=?, lunch_start=?, lunch_end=?, end_time=? WHERE class_code=?`,
    [name, address, parseFloat(lat), parseFloat(lng), parseInt(radius)||200, start_time||'10:00', lunch_start||'13:00', lunch_end||'14:00', end_time||'17:00', classCode]);

  res.json({ message: 'College setup saved!', classCode, address });
});

// GET /api/teacher/students
router.get('/students', authMiddleware, teacherOnly, (req, res) => {
  const students = dbAll(
    'SELECT id, name, email, phone, roll_no, unique_code, parent_code, is_online, last_seen FROM users WHERE role = ? AND class_code = ? ORDER BY name',
    ['student', req.user.class_code]
  );
  res.json({ students });
});

// GET /api/teacher/student/:id
router.get('/student/:id', authMiddleware, teacherOnly, (req, res) => {
  const student = dbGet('SELECT id, name, email, phone, roll_no, unique_code, parent_code FROM users WHERE id = ?', [req.params.id]);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const history = dbAll('SELECT date, period_number, subject, status, total_minutes, entry_time FROM attendance_sessions WHERE student_id = ? ORDER BY date DESC, period_number LIMIT 90', [req.params.id]);
  const present = history.filter(h=>h.status==='present').length;
  res.json({ student, history, stats: { total: history.length, present, pct: history.length ? Math.round((present/history.length)*100) : 0 } });
});

// GET /api/teacher/attendance-sheet — Full day CSV
router.get('/attendance-sheet', authMiddleware, teacherOnly, (req, res) => {
  const classCode = req.user.class_code;
  const classInfo = dbGet('SELECT * FROM classes WHERE class_code = ?', [classCode]);
  const students  = dbAll('SELECT id, name, roll_no FROM users WHERE role = ? AND class_code = ? ORDER BY name', ['student', classCode]);
  const sessions  = dbAll('SELECT student_id, date, status, total_minutes FROM attendance_sessions WHERE student_id IN (SELECT id FROM users WHERE class_code = ?) ORDER BY date DESC LIMIT 500', [classCode]);
  const dates     = [...new Set(sessions.map(s=>s.date))].sort().reverse().slice(0,30);

  let csv = `GeoSelfie — Attendance Sheet\nClass: ${classCode}\nCollege: ${classInfo?.college_name||'N/A'}\n`;
  if (classInfo?.address) csv += `Address: ${classInfo.address}\n`;
  csv += `Generated: ${new Date().toLocaleString('en-IN')}\n© 2026 GeoSelfie — All rights reserved.\n\n`;
  csv += `Roll No,Name,${dates.join(',')},Present,Total,Percentage\n`;

  students.forEach(student => {
    const ss  = sessions.filter(s=>s.student_id===student.id);
    const row = [student.roll_no||'-', student.name];
    let present = 0;
    dates.forEach(date => {
      const s = ss.find(x=>x.date===date);
      if (s?.status==='present') { row.push('P'); present++; }
      else if (s) row.push('A'); else row.push('-');
    });
    row.push(present, dates.length, `${dates.length?Math.round((present/dates.length)*100):0}%`);
    csv += row.join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="GeoSelfie_${classCode}_${today()}.csv"`);
  res.send(csv);
});

// GET /api/teacher/period-attendance-sheet — Period-wise Excel
router.get('/period-attendance-sheet', authMiddleware, teacherOnly, (req, res) => {
  const classCode = req.user.class_code;
  const { date }  = req.query;
  const targetDate = date || today();
  const classInfo = dbGet('SELECT * FROM classes WHERE class_code = ?', [classCode]);
  const students  = dbAll('SELECT id, name, roll_no FROM users WHERE role = ? AND class_code = ? ORDER BY name', ['student', classCode]);
  const periods   = dbAll('SELECT * FROM periods WHERE class_code = ? ORDER BY period_number', [classCode]);
  const sessions  = dbAll('SELECT * FROM attendance_sessions WHERE class_code = ? AND date = ? ORDER BY period_number', [classCode, targetDate]);

  // Create Excel workbook
  const wb = XLSX.utils.book_new();

  // Sheet 1: Period-wise attendance
  const periodHeaders = ['Roll No', 'Student Name', ...periods.map(p=>`P${p.period_number}: ${p.subject}`), 'Total Present', 'Total Periods'];
  const periodData    = [periodHeaders];

  students.forEach(student => {
    const row = [student.roll_no||'-', student.name];
    let presentCount = 0;
    periods.forEach(period => {
      const session = sessions.find(s=>s.student_id===student.id && s.period_number===period.period_number);
      if (session?.status==='present') { row.push('P'); presentCount++; }
      else row.push('A');
    });
    row.push(presentCount, periods.length);
    periodData.push(row);
  });

  const ws1 = XLSX.utils.aoa_to_sheet(periodData);
  XLSX.utils.book_append_sheet(wb, ws1, `Period-wise ${targetDate}`);

  // Sheet 2: Full day summary
  const allDates   = [...new Set(dbAll('SELECT DISTINCT date FROM attendance_sessions WHERE class_code = ? ORDER BY date DESC LIMIT 30', [classCode]).map(r=>r.date))];
  const dayHeaders = ['Roll No', 'Student Name', ...allDates, 'Present Days', 'Total Days', 'Percentage'];
  const dayData    = [dayHeaders];
  const allSessions= dbAll('SELECT student_id, date, status FROM attendance_sessions WHERE class_code = ? ORDER BY date DESC', [classCode]);

  students.forEach(student => {
    const row = [student.roll_no||'-', student.name];
    let present = 0;
    allDates.forEach(d => {
      const hasPresentPeriod = allSessions.some(s=>s.student_id===student.id && s.date===d && s.status==='present');
      if (hasPresentPeriod) { row.push('P'); present++; }
      else row.push('A');
    });
    const pct = allDates.length ? Math.round((present/allDates.length)*100) : 0;
    row.push(present, allDates.length, `${pct}%`);
    dayData.push(row);
  });

  const ws2 = XLSX.utils.aoa_to_sheet(dayData);
  XLSX.utils.book_append_sheet(wb, ws2, 'Daily Summary');

  // Sheet 3: Info
  const infoData = [
    ['GeoSelfie — Attendance Report'],
    ['Class Code', classCode],
    ['College', classInfo?.college_name||'N/A'],
    ['Address', classInfo?.address||'N/A'],
    ['Schedule', `${classInfo?.start_time||'10:00'} - ${classInfo?.end_time||'17:00'}`],
    ['Lunch', `${classInfo?.lunch_start||'13:00'} - ${classInfo?.lunch_end||'14:00'}`],
    ['Generated', new Date().toLocaleString('en-IN')],
    ['', ''],
    ['© 2026 GeoSelfie — Geo Selfie Identity — All rights reserved.'],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(infoData);
  XLSX.utils.book_append_sheet(wb, ws3, 'Info');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="GeoSelfie_${classCode}_${targetDate}.xlsx"`);
  res.send(buffer);
});

module.exports = router;