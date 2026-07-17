/*
 * © 2026 GeoSelfie — All rights reserved.
 * COMPLETE: Excel export, period tracking, 75% warning, suspicious flags, student+parent list
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// ── Dashboard ──
router.get('/dashboard', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const today     = new Date().toISOString().split('T')[0];
    const college   = dbGet('SELECT * FROM classes WHERE class_code=?', [classCode]);

    const students = dbAll(
      'SELECT id FROM users WHERE class_code=? AND role=?',
      [classCode, 'student']
    );
    const totalStudents = students.length;

    const todaySessions = dbAll(
      'SELECT student_id, status FROM attendance_sessions WHERE class_code=? AND date=? AND period_number=0',
      [classCode, today]
    );
    const presentToday = todaySessions.filter(s => s.status === 'present').length;

    // Average attendance %
    const avgData = dbAll(`
      SELECT student_id,
        ROUND(100.0 * SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 0) as pct
      FROM attendance_sessions WHERE class_code=? AND period_number=0
      GROUP BY student_id
    `, [classCode]);
    const avgPct = avgData.length
      ? Math.round(avgData.reduce((s,d) => s+(d.pct||0), 0) / avgData.length)
      : 0;

    // 75% Warning — students below threshold
    const warningStudents = avgData.filter(d => (d.pct||0) < 75).length;

    // Suspicious activity count
    const suspiciousCount = dbGet(
      'SELECT COUNT(*) as count FROM location_events WHERE event_type=? AND student_id IN (SELECT id FROM users WHERE class_code=?)',
      ['fake_gps_attempt', classCode]
    );

    // Verify stats today
    const verifyStats = dbAll(`
      SELECT vl.result, COUNT(*) as count
      FROM verify_logs vl
      JOIN attendance_sessions s ON s.id=vl.session_id
      WHERE s.class_code=? AND s.date=?
      GROUP BY vl.result
    `, [classCode, today]);

    const verifiedCount = verifyStats.find(v => v.result==='verified')?.count || 0;
    const pendingCount  = verifyStats.find(v => v.result==='pending')?.count  || 0;
    const timeoutCount  = verifyStats.find(v => v.result==='timeout')?.count  || 0;

    // Period-wise today stats
    const periodStats = dbAll(`
      SELECT p.period_number, p.subject, p.start_time, p.end_time,
        COUNT(DISTINCT s.student_id) as total,
        SUM(CASE WHEN s.status='present' THEN 1 ELSE 0 END) as present_count
      FROM periods p
      LEFT JOIN attendance_sessions s ON s.period_number=p.period_number AND s.class_code=p.class_code AND s.date=?
      WHERE p.class_code=?
      GROUP BY p.period_number
      ORDER BY p.period_number
    `, [today, classCode]);

    res.json({
      college,
      stats: {
        total_students:    totalStudents,
        present_today:     presentToday,
        absent_today:      totalStudents - presentToday,
        avg_percentage:    avgPct,
        warning_75_count:  warningStudents,
        suspicious_count:  suspiciousCount?.count || 0,
        verified_today:    verifiedCount,
        pending_verify:    pendingCount,
        timeout_verify:    timeoutCount,
      },
      period_stats: periodStats,
    });
  } catch(e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Setup College ──
router.post('/setup-college', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { college_name, address, lat, lng, radius_meters, start_time, lunch_start, lunch_end, end_time, working_days } = req.body;

    if (!lat || !lng)
      return res.status(400).json({ error: 'Location (lat, lng) required' });

    dbRun(`UPDATE classes SET
           college_name=?, address=?, lat=?, lng=?, radius_meters=?,
           start_time=?, lunch_start=?, lunch_end=?, end_time=?, working_days=?
           WHERE class_code=?`,
      [college_name||null, address||null,
       parseFloat(lat), parseFloat(lng), parseInt(radius_meters)||200,
       start_time||'10:00', lunch_start||'13:00', lunch_end||'14:00', end_time||'17:00',
       working_days||'mon,tue,wed,thu,fri,sat',
       req.user.class_code]);

    res.json({ message: 'College setup saved!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Students with Parent Info + Attendance + Suspicious Flag ──
router.get('/students', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const today     = new Date().toISOString().split('T')[0];

    const students = dbAll(
      'SELECT id,name,email,phone,roll_no,unique_code,parent_code,created_at FROM users WHERE class_code=? AND role=? ORDER BY name',
      [classCode, 'student']
    );

    const enriched = students.map(stu => {
      // Parent linking
      let parent = null;
      if (stu.unique_code) {
        parent = dbGet(
          'SELECT id,name,email,phone,unique_code FROM users WHERE parent_code=? AND role=?',
          [stu.unique_code, 'parent']
        );
      }
      if (!parent && stu.parent_code) {
        parent = dbGet(
          'SELECT id,name,email,phone,unique_code FROM users WHERE unique_code=? AND role=?',
          [stu.parent_code, 'parent']
        );
      }

      // Today status
      const todaySes = dbGet(
        'SELECT status, total_minutes FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
        [stu.id, today]
      );

      // Overall attendance % — per unique day
      const attData = dbAll(`
        SELECT DISTINCT date,
          MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
        FROM attendance_sessions WHERE student_id=? AND period_number=0
        GROUP BY date
      `, [stu.id]);
      const totalDays   = attData.length;
      const presentDays = attData.filter(d => d.was_present).length;
      const attPct      = totalDays > 0 ? Math.round((presentDays/totalDays)*100) : 0;

      // Period-wise stats
      const periodData = dbAll(`
        SELECT period_number, subject,
          COUNT(*) as total,
          SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) as present_count
        FROM attendance_sessions WHERE student_id=? AND period_number > 0
        GROUP BY period_number
      `, [stu.id]);

      // Suspicious activity — FIX: Suspicious Activity Flag
      const suspicious = dbGet(
        'SELECT COUNT(*) as count FROM location_events WHERE student_id=? AND event_type=?',
        [stu.id, 'fake_gps_attempt']
      );
      const isSuspicious = (suspicious?.count || 0) > 0;

      // 75% Warning flag
      const isBelow75 = attPct < 75 && totalDays > 0;

      // Pending corrections
      const pendingCorr = dbGet(
        'SELECT COUNT(*) as count FROM correction_requests WHERE student_id=? AND status=?',
        [stu.id, 'pending']
      );

      return {
        ...stu,
        parent_linked:       !!parent,
        parent_info:         parent || null,
        today_status:        todaySes?.status || 'absent',
        today_minutes:       todaySes?.total_minutes || 0,
        attendance_pct:      attPct,
        total_days:          totalDays,
        present_days:        presentDays,
        absent_days:         totalDays - presentDays,
        is_below_75:         isBelow75,        // FIX: 75% Warning
        is_suspicious:       isSuspicious,     // FIX: Suspicious Activity Flag
        suspicious_count:    suspicious?.count || 0,
        period_stats:        periodData,       // FIX: Period-wise Tracking
        pending_corrections: pendingCorr?.count || 0,
      };
    });

    const linkedCount    = enriched.filter(s => s.parent_linked).length;
    const unlinkedCount  = enriched.filter(s => !s.parent_linked).length;
    const below75Count   = enriched.filter(s => s.is_below_75).length;
    const suspiciousCount= enriched.filter(s => s.is_suspicious).length;

    res.json({
      students: enriched,
      summary: {
        total:      students.length,
        linked:     linkedCount,
        unlinked:   unlinkedCount,
        below_75:   below75Count,
        suspicious: suspiciousCount,
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Single Student Detail ──
router.get('/student/:id', authMiddleware, teacherOnly, (req, res) => {
  try {
    const student = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    let parent = null;
    if (student.unique_code) {
      parent = dbGet('SELECT id,name,email,phone FROM users WHERE parent_code=? AND role=?', [student.unique_code,'parent']);
    }

    // Day-wise history
    const dayHistory = dbAll(`
      SELECT DISTINCT date,
        MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present,
        SUM(total_minutes) as total_minutes,
        MIN(entry_time) as entry_time,
        MAX(exit_time) as exit_time
      FROM attendance_sessions WHERE student_id=? AND period_number=0
      GROUP BY date ORDER BY date DESC LIMIT 30
    `, [req.params.id]);

    // Period-wise history
    const periodHistory = dbAll(`
      SELECT s.*, p.start_time as period_start, p.end_time as period_end
      FROM attendance_sessions s
      LEFT JOIN periods p ON p.id=s.period_id
      WHERE s.student_id=? AND s.period_number > 0
      ORDER BY s.date DESC, s.period_number LIMIT 50
    `, [req.params.id]);

    const presentDays = dayHistory.filter(d => d.was_present).length;
    const attPct      = dayHistory.length > 0 ? Math.round((presentDays/dayHistory.length)*100) : 0;

    // Suspicious
    const suspicious = dbAll(
      'SELECT * FROM location_events WHERE student_id=? AND event_type=? ORDER BY timestamp DESC LIMIT 10',
      [req.params.id, 'fake_gps_attempt']
    );

    // Verify logs
    const verifyLogs = dbAll(`
      SELECT vl.*, s.date FROM verify_logs vl
      JOIN attendance_sessions s ON s.id=vl.session_id
      WHERE vl.student_id=? ORDER BY vl.sent_at DESC LIMIT 20
    `, [req.params.id]);

    // Homework
    const homework = dbAll(`
      SELECT h.title, h.subject, h.due_date, hs.submitted_at, hs.grade
      FROM homework h
      LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=?
      WHERE h.class_code=? ORDER BY h.created_at DESC LIMIT 10
    `, [req.params.id, student.class_code]);

    res.json({
      student,
      parent_info:    parent,
      day_history:    dayHistory,
      period_history: periodHistory,
      analytics: {
        total_days:   dayHistory.length,
        present_days: presentDays,
        absent_days:  dayHistory.length - presentDays,
        percentage:   attPct,
        is_below_75:  attPct < 75,
        is_suspicious: suspicious.length > 0,
      },
      suspicious_events: suspicious,
      verify_logs:   verifyLogs,
      homework,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Verify Stats ──
router.get('/verify-stats/:date', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const date      = req.params.date;

    // General verify
    const general = dbAll(`
      SELECT vl.id, vl.result, vl.sent_at, vl.responded_at, vl.subject,
             u.name as student_name, u.roll_no
      FROM verify_logs vl
      JOIN users u ON u.id=vl.student_id
      JOIN attendance_sessions s ON s.id=vl.session_id
      WHERE s.class_code=? AND s.date=? AND vl.period_number=0
      ORDER BY vl.sent_at DESC
    `, [classCode, date]);

    // Period-wise verify
    const periodWise = dbAll(`
      SELECT vl.period_number, vl.subject,
        SUM(CASE WHEN vl.result='verified' THEN 1 ELSE 0 END) as verified,
        SUM(CASE WHEN vl.result='pending'  THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN vl.result='timeout'  THEN 1 ELSE 0 END) as timeout,
        COUNT(*) as total
      FROM verify_logs vl
      JOIN attendance_sessions s ON s.id=vl.session_id
      WHERE s.class_code=? AND s.date=?
      GROUP BY vl.period_number
      ORDER BY vl.period_number
    `, [classCode, date]);

    res.json({ general, period_wise: periodWise });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV Attendance Sheet ──
router.get('/attendance-sheet', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code;
    const college   = dbGet('SELECT college_name FROM classes WHERE class_code=?', [classCode]);

    const students = dbAll(
      'SELECT id,name,roll_no FROM users WHERE class_code=? AND role=? ORDER BY CAST(roll_no AS INTEGER)',
      [classCode, 'student']
    );
    const dates = dbAll(`
      SELECT DISTINCT date FROM attendance_sessions WHERE class_code=? AND period_number=0
      ORDER BY date DESC LIMIT 30
    `, [classCode]);

    let csv = `GeoSelfie Attendance Report\n`;
    csv += `College: ${college?.college_name || classCode}\n`;
    csv += `Generated: ${new Date().toLocaleDateString('en-IN')}\n\n`;
    csv += `Roll No,Name,${dates.map(d => d.date).join(',')},Total Days,Present,Absent,Percentage,Warning\n`;

    students.forEach(stu => {
      const row = [stu.roll_no||'', `"${stu.name||''}"`];
      let present = 0;
      dates.forEach(d => {
        const att = dbGet(
          'SELECT status FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
          [stu.id, d.date]
        );
        const s = att?.status === 'present' ? 'P' : 'A';
        if (s === 'P') present++;
        row.push(s);
      });
      const total = dates.length;
      const pct   = total > 0 ? Math.round((present/total)*100) : 0;
      row.push(total, present, total-present, `${pct}%`, pct < 75 ? 'WARNING' : '');
      csv += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${classCode}_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teacher/attendance-csv?type=daily|monthly|period|overall
router.get('/attendance-csv', authMiddleware, teacherOnly, (req, res) => {
  try {
    const classCode = req.user.class_code
    const { type = 'overall', date, month } = req.query
    const college   = dbGet('SELECT college_name FROM classes WHERE class_code=?', [classCode])
    const students  = dbAll(
      'SELECT id,name,roll_no FROM users WHERE class_code=? AND role=? ORDER BY CAST(roll_no AS INTEGER)',
      [classCode, 'student']
    )

    let csv = `GeoSelfie Attendance — ${type.toUpperCase()}\n`
    csv += `Class: ${classCode} | ${college?.college_name||''}\n`
    csv += `Generated: ${new Date().toLocaleDateString('en-IN')}\n\n`

    if (type === 'daily') {
      // Today's attendance
      const today = date || new Date().toISOString().split('T')[0]
      csv += `Date: ${today}\n\n`
      csv += `Roll No,Name,Status,Time on Campus,Entry Time,Exit Time\n`
      students.forEach(stu => {
        const s = dbGet(
          'SELECT status,total_minutes,entry_time,exit_time FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
          [stu.id, today]
        )
        const mins  = s?.total_minutes || 0
        const hrs   = `${Math.floor(mins/60)}h ${mins%60}m`
        const entry = s?.entry_time ? new Date(s.entry_time).toLocaleTimeString('en-IN') : '-'
        const exit  = s?.exit_time  ? new Date(s.exit_time).toLocaleTimeString('en-IN')  : '-'
        csv += `${stu.roll_no||''},${stu.name||''},${s?.status||'absent'},${hrs},${entry},${exit}\n`
      })

    } else if (type === 'monthly') {
      // Month-wise
      const targetMonth = month || new Date().toISOString().slice(0,7)
      csv += `Month: ${targetMonth}\n\n`
      const monthDates = dbAll(`
        SELECT DISTINCT date FROM attendance_sessions WHERE class_code=? AND date LIKE ? AND period_number=0
        ORDER BY date
      `, [classCode, `${targetMonth}%`])

      csv += `Roll No,Name,${monthDates.map(d=>d.date).join(',')},Total Days,Present,Percentage\n`
      students.forEach(stu => {
        const row = [stu.roll_no||'', `"${stu.name||''}"`]
        let present = 0
        monthDates.forEach(d => {
          const att = dbGet('SELECT status FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0', [stu.id,d.date])
          const st  = att?.status==='present' ? 'P' : 'A'
          if (st==='P') present++
          row.push(st)
        })
        const pct = monthDates.length>0 ? Math.round((present/monthDates.length)*100) : 0
        row.push(monthDates.length, present, `${pct}%`)
        csv += row.join(',') + '\n'
      })

    } else if (type === 'period') {
      // Period-wise
      const targetDate = date || new Date().toISOString().split('T')[0]
      csv += `Date: ${targetDate} — Period-wise\n\n`
      const periods = dbAll('SELECT * FROM periods WHERE class_code=? ORDER BY period_number', [classCode])
      csv += `Roll No,Name,${periods.map(p=>`P${p.period_number}(${p.subject})`).join(',')}\n`
      students.forEach(stu => {
        const row = [stu.roll_no||'', `"${stu.name||''}"`]
        periods.forEach(p => {
          const att = dbGet(
            'SELECT status FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=?',
            [stu.id, targetDate, p.period_number]
          )
          row.push(att?.status==='present' ? 'P' : 'A')
        })
        csv += row.join(',') + '\n'
      })

    } else {
      // Overall (default)
      const dates = dbAll(`
        SELECT DISTINCT date FROM attendance_sessions WHERE class_code=? AND period_number=0
        ORDER BY date DESC LIMIT 30
      `, [classCode])
      csv += `Roll No,Name,${dates.map(d=>d.date).join(',')},Total Days,Present,Absent,Percentage,Status\n`
      students.forEach(stu => {
        const row = [stu.roll_no||'', `"${stu.name||''}"`]
        let present = 0
        dates.forEach(d => {
          const att = dbGet('SELECT status FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',[stu.id,d.date])
          const st  = att?.status==='present' ? 'P' : 'A'
          if (st==='P') present++
          row.push(st)
        })
        const total = dates.length
        const pct   = total>0 ? Math.round((present/total)*100) : 0
        row.push(total, present, total-present, `${pct}%`, pct<75?'WARNING':'OK')
        csv += row.join(',') + '\n'
      })
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="GeoSelfie_${type}_${classCode}.csv"`)
    res.send('\uFEFF' + csv)
  } catch(e) { res.status(500).json({ error: e.message }) }
})
// ── FIX: Excel Multi-sheet Export ──
router.get('/period-attendance-sheet', authMiddleware, teacherOnly, async (req, res) => {
  try {
    const classCode = req.user.class_code;
    const date      = req.query.date || new Date().toISOString().split('T')[0];
    const college   = dbGet('SELECT college_name FROM classes WHERE class_code=?', [classCode]);

    const students = dbAll(
      'SELECT id,name,roll_no FROM users WHERE class_code=? AND role=? ORDER BY CAST(roll_no AS INTEGER)',
      [classCode, 'student']
    );
    const periods = dbAll(
      'SELECT * FROM periods WHERE class_code=? ORDER BY day, period_number',
      [classCode]
    );

    // Build multi-sheet Excel using ExcelJS
    let ExcelJS;
    try { ExcelJS = require('exceljs'); }
    catch {
      // Fallback to CSV if ExcelJS not installed
      return res.redirect(`/api/teacher/attendance-sheet?date=${date}`);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'GeoSelfie';

    // ── Sheet 1: Overall Summary ──
    const summarySheet = workbook.addWorksheet('Overall Summary', {
      pageSetup: { orientation: 'landscape' }
    });

    summarySheet.mergeCells('A1:G1');
    summarySheet.getCell('A1').value = `${college?.college_name || 'GeoSelfie'} — Attendance Report`;
    summarySheet.getCell('A1').font  = { size:16, bold:true, color:{ argb:'FF1A56DB' } };

    summarySheet.mergeCells('A2:G2');
    summarySheet.getCell('A2').value = `Generated: ${new Date().toLocaleDateString('en-IN')} | Class: ${classCode}`;
    summarySheet.getCell('A2').font  = { size:11, italic:true, color:{ argb:'FF475569' } };

    summarySheet.addRow([]);

    const headerRow = summarySheet.addRow(['Roll No','Student Name','Total Days','Present','Absent','Percentage','Status']);
    headerRow.font  = { bold:true, color:{ argb:'FFFFFFFF' } };
    headerRow.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A56DB' } };
    headerRow.alignment = { horizontal:'center' };
    summarySheet.columns = [
      { key:'roll',    width:12 },
      { key:'name',    width:28 },
      { key:'total',   width:14 },
      { key:'present', width:12 },
      { key:'absent',  width:12 },
      { key:'pct',     width:14 },
      { key:'status',  width:18 },
    ];

    students.forEach(stu => {
      const attData = dbAll(`
        SELECT DISTINCT date,
          MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
        FROM attendance_sessions WHERE student_id=? AND period_number=0
        GROUP BY date
      `, [stu.id]);
      const total   = attData.length;
      const present = attData.filter(d => d.was_present).length;
      const pct     = total > 0 ? Math.round((present/total)*100) : 0;

      const row = summarySheet.addRow({
        roll:    stu.roll_no || '',
        name:    stu.name    || '',
        total,
        present,
        absent:  total - present,
        pct:     `${pct}%`,
        status:  pct < 75 ? '⚠ BELOW 75%' : '✓ OK',
      });

      // FIX: 75% Warning — red highlight
      if (pct < 75) {
        row.getCell('status').fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEF2F2' } };
        row.getCell('status').font = { bold:true, color:{ argb:'FFDC2626' } };
        row.getCell('pct').font    = { bold:true, color:{ argb:'FFDC2626' } };
      } else {
        row.getCell('status').font = { color:{ argb:'FF059669' } };
      }
      row.alignment = { horizontal:'center' };
    });

    // ── Sheet 2: Day-wise Attendance ──
    const dates = dbAll(`
      SELECT DISTINCT date FROM attendance_sessions WHERE class_code=? AND period_number=0
      ORDER BY date DESC LIMIT 30
    `, [classCode]);

    const daySheet = workbook.addWorksheet('Day-wise');
    daySheet.addRow(['Roll No', 'Name', ...dates.map(d => d.date), 'Total', 'Present', '%']);

    const dayHeaderRow = daySheet.getRow(1);
    dayHeaderRow.font = { bold:true, color:{ argb:'FFFFFFFF' } };
    dayHeaderRow.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF059669' } };

    students.forEach(stu => {
      const row = [stu.roll_no||'', stu.name||''];
      let present = 0;
      dates.forEach(d => {
        const att = dbGet(
          'SELECT status FROM attendance_sessions WHERE student_id=? AND date=? AND period_number=0',
          [stu.id, d.date]
        );
        const s = att?.status === 'present' ? 'P' : 'A';
        if (s === 'P') present++;
        row.push(s);
      });
      const total = dates.length;
      const pct   = total > 0 ? Math.round((present/total)*100) : 0;
      row.push(total, present, `${pct}%`);
      const addedRow = daySheet.addRow(row);

      // Color P/A cells
      dates.forEach((d, i) => {
        const cell  = addedRow.getCell(3 + i);
        const isPres = cell.value === 'P';
        cell.fill   = { type:'pattern', pattern:'solid', fgColor:{ argb: isPres ? 'FFECFDF5' : 'FFFEF2F2' } };
        cell.font   = { bold:true, color:{ argb: isPres ? 'FF059669' : 'FFDC2626' } };
        cell.alignment = { horizontal:'center' };
      });
    });

    // ── Sheet 3: FIX: Period-wise Tracking ──
    const dayNames = ['mon','tue','wed','thu','fri','sat'];
    for (const day of dayNames) {
      const dayPeriods = periods.filter(p => p.day === day);
      if (!dayPeriods.length) continue;

      const dayLabel = { mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday', sat:'Saturday' }[day];
      const pSheet   = workbook.addWorksheet(`Periods-${dayLabel}`);

      // Header
      pSheet.addRow([`Period-wise Attendance — ${dayLabel}`]);
      pSheet.getRow(1).font = { bold:true, size:13, color:{ argb:'FF1A56DB' } };
      pSheet.addRow([]);

      const periodHeaders = ['Roll No', 'Name', ...dayPeriods.map(p => `P${p.period_number}-${p.subject}`)];
      pSheet.addRow(periodHeaders);
      const pHeaderRow = pSheet.getRow(3);
      pHeaderRow.font  = { bold:true, color:{ argb:'FFFFFFFF' } };
      pHeaderRow.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF7C3AED' } };

      students.forEach(stu => {
        const row = [stu.roll_no||'', stu.name||''];
        dayPeriods.forEach(p => {
          // All records for this student + period
          const recs = dbAll(
            `SELECT status FROM attendance_sessions WHERE student_id=? AND period_number=? ORDER BY date DESC LIMIT 1`,
            [stu.id, p.period_number]
          );
          const latest = recs[0]?.status;
          row.push(latest === 'present' ? 'P' : latest === 'absent' ? 'A' : '-');
        });
        const addedRow = pSheet.addRow(row);
        dayPeriods.forEach((p, i) => {
          const cell  = addedRow.getCell(3 + i);
          cell.fill   = { type:'pattern', pattern:'solid', fgColor:{ argb: cell.value==='P'?'FFECFDF5': cell.value==='-'?'FFF8FAFC':'FFFEF2F2' } };
          cell.font   = { color:{ argb: cell.value==='P'?'FF059669':'FFDC2626' } };
          cell.alignment = { horizontal:'center' };
        });
      });

      pSheet.columns = [
        { width:12 }, { width:25 },
        ...dayPeriods.map(() => ({ width:18 }))
      ];
    }

    // ── Sheet 4: FIX: Suspicious Activity Report ──
    const suspSheet = workbook.addWorksheet('Suspicious Activity');
    suspSheet.addRow(['Suspicious Activity Report']);
    suspSheet.getRow(1).font = { bold:true, size:13, color:{ argb:'FFDC2626' } };
    suspSheet.addRow([]);
    suspSheet.addRow(['Roll No', 'Student Name', 'Attempts', 'Last Attempt', 'Risk Level']);
    const suspHeaderRow = suspSheet.getRow(3);
    suspHeaderRow.font  = { bold:true, color:{ argb:'FFFFFFFF' } };
    suspHeaderRow.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFDC2626' } };

    students.forEach(stu => {
      const attempts = dbGet(
        'SELECT COUNT(*) as count, MAX(timestamp) as last FROM location_events WHERE student_id=? AND event_type=?',
        [stu.id, 'fake_gps_attempt']
      );
      if (!attempts?.count) return;

      const risk = attempts.count > 5 ? 'HIGH' : attempts.count > 2 ? 'MEDIUM' : 'LOW';
      const row  = suspSheet.addRow([
        stu.roll_no||'', stu.name||'', attempts.count,
        attempts.last ? new Date(attempts.last).toLocaleString('en-IN') : '',
        risk
      ]);
      const colors = { HIGH:'FFDC2626', MEDIUM:'FFD97706', LOW:'FF1A56DB' };
      row.getCell(5).font = { bold:true, color:{ argb: colors[risk] } };
    });

    // ── Sheet 5: 75% Warning List ──
    const warnSheet = workbook.addWorksheet('Below 75% Warning');
    warnSheet.addRow(['Students Below 75% Attendance — Action Required']);
    warnSheet.getRow(1).font = { bold:true, size:13, color:{ argb:'FFD97706' } };
    warnSheet.addRow([]);
    warnSheet.addRow(['Roll No', 'Name', 'Email', 'Phone', 'Total Days', 'Present', 'Percentage', 'Action Needed']);
    const warnHeaderRow = warnSheet.getRow(3);
    warnHeaderRow.font  = { bold:true, color:{ argb:'FFFFFFFF' } };
    warnHeaderRow.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD97706' } };

    students.forEach(stu => {
      const attData = dbAll(`
        SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
        FROM attendance_sessions WHERE student_id=? AND period_number=0 GROUP BY date
      `, [stu.id]);
      const total   = attData.length;
      const present = attData.filter(d => d.was_present).length;
      const pct     = total > 0 ? Math.round((present/total)*100) : 0;
      if (pct >= 75 || total === 0) return;

      const row = warnSheet.addRow([
        stu.roll_no||'', stu.name||'', stu.email||'', stu.phone||'',
        total, present, `${pct}%`, 'CONTACT PARENT IMMEDIATELY'
      ]);
      row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEF9C3' } };
    });

    // Send Excel
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="GeoSelfie_${classCode}_${date}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch(e) {
    console.error('Excel export error:', e.message);
    res.status(500).json({ error: 'Excel export failed: ' + e.message });
  }
});

// ─────────────────────────────────────────────
// Reset School Data
// POST /api/teacher/reset-school-data
// ─────────────────────────────────────────────
router.post('/reset-school-data', authMiddleware, teacherOnly, (req, res) => {
  try {
    const {
      reset_attendance,
      reset_academics,
      reset_chats,
      reset_notices
    } = req.body;

    const classCode = req.user.class_code;

    if (reset_attendance) {

      const students = dbAll(
        'SELECT id FROM users WHERE class_code=? AND role=?',
        [classCode, 'student']
      );

      students.forEach(s => {
        dbRun('DELETE FROM attendance_sessions WHERE student_id=?', [s.id]);
        dbRun('DELETE FROM verify_logs WHERE student_id=?', [s.id]);
        dbRun('DELETE FROM location_events WHERE student_id=?', [s.id]);
        dbRun('DELETE FROM correction_requests WHERE student_id=?', [s.id]);
        dbRun('DELETE FROM offline_queue WHERE student_id=?', [s.id]);
      });

      dbRun(
        'UPDATE classes SET auto_verify_active=0, last_verify_sent_at=NULL WHERE class_code=?',
        [classCode]
      );
    }

    if (reset_academics) {

      dbRun('DELETE FROM homework WHERE class_code=?', [classCode]);

      dbRun('DELETE FROM exams WHERE class_code=?', [classCode]);

      const students = dbAll(
        'SELECT id FROM users WHERE class_code=? AND role=?',
        [classCode, 'student']
      );

      students.forEach(s => {
        dbRun('DELETE FROM homework_submissions WHERE student_id=?', [s.id]);
        dbRun('DELETE FROM marks WHERE student_id=?', [s.id]);
        dbRun('DELETE FROM report_cards WHERE student_id=?', [s.id]);
      });

    }

    if (reset_chats) {

      const chatIds = dbAll(`
        SELECT DISTINCT chat_id
        FROM chat_members
        WHERE user_id IN (
          SELECT id FROM users WHERE class_code=?
        )
      `,[classCode]);

      chatIds.forEach(c => {

        dbRun(
          'DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)',
          [c.chat_id]
        );

        dbRun(
          'DELETE FROM messages WHERE chat_id=?',
          [c.chat_id]
        );

      });

    }

    if (reset_notices) {

      dbRun(
        'DELETE FROM notices WHERE class_code=?',
        [classCode]
      );

      dbRun(
        'DELETE FROM notice_reads WHERE notice_id NOT IN (SELECT id FROM notices)'
      );

      dbRun(
        'UPDATE qr_sessions SET is_active=0 WHERE class_code=?',
        [classCode]
      );

    }

    res.json({
      success: true,
      message: 'School data reset successfully. Accounts are preserved.',
      reset: {
        attendance: !!reset_attendance,
        academics: !!reset_academics,
        chats: !!reset_chats,
        notices: !!reset_notices
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e.message
    });
  }
});

module.exports = router;