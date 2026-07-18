/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Professional report card — no localhost
 */
const express = require('express');
const { dbGet, dbAll } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();

function getGrade(pct) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B+';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 40) return 'D';
  return 'F';
}

function getGradeColor(grade) {
  if (['A+','A'].includes(grade)) return '#059669';
  if (['B+','B'].includes(grade))  return '#1A56DB';
  if (grade === 'C')               return '#D97706';
  if (grade === 'D')               return '#F97316';
  return '#DC2626';
}

// GET /api/report-card/:studentId — HTML report card
router.get('/:studentId', (req, res) => {
  try {
// FIX 9: Token from query param OR Authorization header
let userId = null

const headerToken = req.headers.authorization?.split(' ')[1]
const queryToken  = req.query.token

const token = headerToken || queryToken

if (!token) {
  return res
    .status(401)
    .send('<h2>No token provided. Please login and try again.</h2>')
}

const jwt = require('jsonwebtoken')

try {
  const decoded = jwt.verify(token, process.env.JWT_SECRET)
  userId = decoded.id
} catch (e) {
  return res
    .status(401)
    .send('<h2>Session expired. Please login again.</h2>')
}

    const student = dbGet(
      'SELECT * FROM users WHERE id=?', [req.params.studentId]
    );
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const cls     = student.class_code
      ? dbGet('SELECT * FROM classes WHERE class_code=?', [student.class_code])
      : null;
    const teacher = cls
      ? dbGet('SELECT name FROM users WHERE id=?', [cls.teacher_id])
      : null;

    const exams = dbAll(`
      SELECT e.*, m.marks_obtained, m.grade, m.remarks
      FROM exams e
      LEFT JOIN marks m ON m.exam_id=e.id AND m.student_id=?
      WHERE e.class_code=?
      ORDER BY e.exam_date ASC
    `, [student.id, student.class_code]);

    const attHistory = dbAll(`
      SELECT date, status FROM attendance_sessions
      WHERE student_id=? AND period_number=0
      ORDER BY date DESC LIMIT 100
    `, [student.id]);

    const totalDays   = attHistory.length;
    const presentDays = attHistory.filter(a => a.status === 'present').length;
    const attPct      = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    const totalMarks   = exams.reduce((s, e) => s + (e.total_marks || 0), 0);
    const obtainedMark = exams.reduce((s, e) => s + (parseFloat(e.marks_obtained) || 0), 0);
    const overallPct   = totalMarks > 0 ? Math.round((obtainedMark / totalMarks) * 100) : 0;
    const grade        = getGrade(overallPct);

    const date = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' });

    const subjectRows = exams.map(e => {
      const subPct   = e.total_marks ? Math.round(((parseFloat(e.marks_obtained)||0) / e.total_marks) * 100) : 0;
      const subGrade = getGrade(subPct);
      const color    = getGradeColor(subGrade);
      return `
        <tr>
          <td>${e.subject || 'N/A'}</td>
          <td>${e.title || 'N/A'}</td>
          <td>${e.total_marks || 0}</td>
          <td style="font-weight:700;color:${color}">${parseFloat(e.marks_obtained)||0}</td>
          <td>${subPct}%</td>
          <td><span style="background:${color}18;color:${color};padding:2px 10px;border-radius:6px;font-weight:700;font-size:13px">${subGrade}</span></td>
          <td style="font-size:12px;color:#475569">${e.remarks||''}</td>
        </tr>
      `;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Report Card — ${student.name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,Arial,sans-serif;background:#F1F5F9;color:#0F172A;padding:20px}
    .card{max-width:850px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#1A56DB,#059669);padding:32px 40px;color:#fff;display:flex;justify-content:space-between;align-items:center}
    .school-name{font-size:22px;font-weight:800;margin-bottom:4px}
    .school-sub{font-size:13px;opacity:.8}
    .report-title{text-align:right}
    .report-title h2{font-size:20px;font-weight:800}
    .report-title p{font-size:12px;opacity:.8;margin-top:4px}
    .student-sec{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:28px 40px;border-bottom:1px solid #E2E8F0;background:#F8FAFC}
    .info-group label{font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:4px}
    .info-group p{font-size:15px;font-weight:600;color:#0F172A}
    .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#E2E8F0;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0}
    .sum-box{background:#fff;padding:20px;text-align:center}
    .sum-val{font-size:28px;font-weight:800;margin-bottom:4px}
    .sum-label{font-size:11px;color:#475569;font-weight:500}
    .marks-sec{padding:28px 40px}
    .marks-sec h3{font-size:14px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}
    grid{width:100%;border-collapse:collapse}
    th{background:#F1F5F9;padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px}
    td{padding:12px 14px;border-bottom:1px solid #E2E8F0;font-size:14px;color:#475569}
    tr:last-child td{border-bottom:none}
    .att-sec{padding:0 40px 28px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .att-box{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:16px}
    .att-box h4{font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
    .att-pct{font-size:28px;font-weight:800;color:${attPct < 75 ? '#DC2626' : '#059669'};margin-bottom:4px}
    .progress-bar{height:8px;border-radius:4px;background:#E2E8F0;overflow:hidden;margin-top:8px}
    .progress-fill{height:100%;border-radius:4px;background:${attPct < 75 ? '#DC2626' : '#059669'};width:${attPct}%}
    .sig-sec{padding:28px 40px;display:grid;grid-template-columns:1fr 1fr;gap:40px;border-top:1px solid #E2E8F0}
    .sig-box{text-align:center}
    .sig-line{border-top:1.5px solid #0F172A;padding-top:8px;font-size:13px;font-weight:600;color:#0F172A;margin-top:40px}
    .sig-sub{font-size:11px;color:#94A3B8;margin-top:2px}
    .footer{background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 40px;text-align:center;font-size:12px;color:#94A3B8}
    .print-btn{margin:20px auto;display:block;padding:12px 28px;background:#1A56DB;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;max-width:850px}
    @media print{body{background:#fff;padding:0}.card{box-shadow:none;border-radius:0}.print-btn{display:none}}
  </style>
</head>
<body>
<button class="print-btn" onclick="window.print()">🖨 Print Report Card / Save file-text</button>
<div class="card">
  <div class="hdr">
    <div>
      <div class="school-name">${cls?.college_name || 'GeoSelfie School'}</div>
      <div class="school-sub">Powered by GeoSelfie — Smart Presence, Verified</div>
    </div>
    <div class="report-title">
      <h2>STUDENT REPORT CARD</h2>
      <p>Date: ${date}</p>
      <p>Class: ${student.class_code || 'N/A'}</p>
    </div>
  </div>

  <div class="student-sec">
    <div class="info-group"><label>Student Name</label><p>${student.name}</p></div>
    <div class="info-group"><label>Roll Number</label><p>${student.roll_no || 'N/A'}</p></div>
    <div class="info-group"><label>Email</label><p>${student.email}</p></div>
    <div class="info-group"><label>Class Code</label><p>${student.class_code || 'N/A'}</p></div>
    <div class="info-group"><label>Class Teacher</label><p>${teacher?.name || 'N/A'}</p></div>
    <div class="info-group"><label>Report Generated</label><p>${date}</p></div>
  </div>

  <div class="summary">
    <div class="sum-box"><div class="sum-val" style="color:#1A56DB">${exams.length}</div><div class="sum-label">Total Exams</div></div>
    <div class="sum-box"><div class="sum-val" style="color:#059669">${obtainedMark}</div><div class="sum-label">Marks Obtained</div></div>
    <div class="sum-box"><div class="sum-val" style="color:#D97706">${overallPct}%</div><div class="sum-label">Overall %</div></div>
    <div class="sum-box"><div class="sum-val" style="color:${getGradeColor(grade)}">${grade}</div><div class="sum-label">Overall Grade</div></div>
  </div>

  <div class="marks-sec">
    <h3>Subject-wise Performance</h3>
    ${exams.length > 0 ? `
    <grid>
      <thead>
        <tr>
          <th>Subject</th>
          <th>Exam</th>
          <th>Max Marks</th>
          <th>Marks Obtained</th>
          <th>Percentage</th>
          <th>Grade</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${subjectRows}
        <tr style="background:#F8FAFC">
          <td colspan="2" style="font-weight:700;color:#0F172A">TOTAL</td>
          <td style="font-weight:700;color:#0F172A">${totalMarks}</td>
          <td style="font-weight:800;color:#1A56DB">${obtainedMark}</td>
          <td style="font-weight:800;color:#1A56DB">${overallPct}%</td>
          <td><span style="background:${getGradeColor(grade)}18;color:${getGradeColor(grade)};padding:2px 10px;border-radius:6px;font-weight:800">${grade}</span></td>
          <td></td>
        </tr>
      </tbody>
    </grid>
    ` : '<p style="color:#94A3B8;text-align:center;padding:20px">No exam records found</p>'}
  </div>

  <div class="att-sec">
    <div class="att-box">
      <h4>Attendance Summary</h4>
      <div class="att-pct">${attPct}%</div>
      <div style="font-size:13px;color:#475569">${presentDays} Present / ${totalDays} Total Days</div>
      <div class="progress-bar"><div class="progress-fill"></div></div>
      ${attPct < 75 ? '<p style="font-size:12px;color:#DC2626;margin-top:8px;font-weight:600">⚠ Below 75% minimum</p>' : '<p style="font-size:12px;color:#059669;margin-top:8px;font-weight:600">✓ Satisfactory attendance</p>'}
    </div>
    <div class="att-box">
      <h4>Performance Summary</h4>
      <div style="font-size:28px;font-weight:800;color:${getGradeColor(grade)};margin-bottom:4px">${grade}</div>
      <div style="font-size:13px;color:#475569">${overallPct}% Overall Score</div>
      ${overallPct >= 75
        ? '<p style="font-size:12px;color:#059669;margin-top:8px;font-weight:600">✓ Promoted</p>'
        : '<p style="font-size:12px;color:#DC2626;margin-top:8px;font-weight:600">⚠ Needs Improvement</p>'
      }
    </div>
  </div>

  <div class="sig-sec">
    <div class="sig-box">
      <div class="sig-line">${teacher?.name || 'Class Teacher'}</div>
      <div class="sig-sub">Class Teacher</div>
    </div>
    <div class="sig-box">
      <div class="sig-line">Principal</div>
      <div class="sig-sub">${cls?.college_name || 'School'}</div>
    </div>
  </div>

  <div class="footer">
    <p>This is a computer-generated report card · Powered by GeoSelfie — Geo Selfie Identity</p>
    <p style="margin-top:4px">© 2026 GeoSelfie · All rights reserved</p>
  </div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
