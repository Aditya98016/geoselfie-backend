/*
 * © 2026 GeoSelfie — All rights reserved.
 */
const express = require('express');
const { dbGet, dbAll } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return 'AI insights unavailable — GEMINI_API_KEY not configured.';

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.';
  } catch(e) {
    return 'AI service temporarily unavailable.';
  }
}

// GET /api/ai/attendance-insights
router.get('/attendance-insights', authMiddleware, teacherOnly, async (req, res) => {
  try {
    const classCode = req.user.class_code;
    const students  = dbAll(
      'SELECT id, name, roll_no FROM users WHERE class_code=? AND role=?',
      [classCode, 'student']
    );

    const insights = students.map(stu => {
      const days     = dbAll(`
        SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
        FROM attendance_sessions WHERE student_id=? AND period_number=0 GROUP BY date
      `, [stu.id]);
      const total    = days.length;
      const present  = days.filter(d => d.was_present).length;
      const pct      = total > 0 ? Math.round((present/total)*100) : 0;
      const susp     = dbGet('SELECT COUNT(*) as c FROM location_events WHERE student_id=? AND event_type=?', [stu.id,'fake_gps_attempt']);

      return {
        name:       stu.name,
        roll_no:    stu.roll_no,
        percentage: pct,
        total_days: total,
        below_75:   pct < 75,
        suspicious: (susp?.c||0) > 0,
        suspicious_count: susp?.c || 0,
      };
    });

    const below75    = insights.filter(s => s.below_75);
    const suspicious = insights.filter(s => s.suspicious);
    const avgPct     = insights.length
      ? Math.round(insights.reduce((s,i) => s+i.percentage, 0) / insights.length)
      : 0;

    const prompt = `
You are an academic attendance advisor for an Indian school/college.
Class: ${classCode}
Total Students: ${students.length}
Average Attendance: ${avgPct}%
Students below 75%: ${below75.length}
Suspicious GPS attempts: ${suspicious.length}

Below 75% students: ${below75.map(s => `${s.name}(${s.percentage}%)`).join(', ') || 'None'}
Suspicious students: ${suspicious.map(s => `${s.name}(${s.suspicious_count} attempts)`).join(', ') || 'None'}

Provide:
1. Overall attendance health summary (2-3 sentences)
2. Specific action for below-75% students
3. Note about suspicious GPS activity if any
4. Top 2 recommendations for improving attendance

Keep it concise, professional, in English.`;

    const aiText = await callGemini(prompt);

    res.json({
      summary: { avg_percentage: avgPct, below_75_count: below75.length, suspicious_count: suspicious.length },
      students: insights,
      ai_insights: aiText,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ai/student-risk/:studentId
router.get('/student-risk/:studentId', authMiddleware, async (req, res) => {
  try {
    const student  = dbGet('SELECT * FROM users WHERE id=?', [req.params.studentId]);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const days     = dbAll(`
      SELECT DISTINCT date, MAX(CASE WHEN status='present' THEN 1 ELSE 0 END) as was_present
      FROM attendance_sessions WHERE student_id=? AND period_number=0 GROUP BY date ORDER BY date DESC
    `, [req.params.studentId]);
    const present  = days.filter(d => d.was_present).length;
    const pct      = days.length > 0 ? Math.round((present/days.length)*100) : 0;

    const suspicious = dbGet(
      'SELECT COUNT(*) as count FROM location_events WHERE student_id=? AND event_type=?',
      [req.params.studentId, 'fake_gps_attempt']
    );

    const recent7  = days.slice(0,7);
    const recent7P = recent7.filter(d => d.was_present).length;

    const prompt = `
Student: ${student.name}, Roll: ${student.roll_no || 'N/A'}
Overall Attendance: ${pct}% (${present}/${days.length} days)
Last 7 days: ${recent7P}/7 days present
Fake GPS attempts: ${suspicious?.count || 0}

Analyze risk and provide:
1. Risk level: LOW / MEDIUM / HIGH
2. Key observations (2-3 points)
3. Recommended action for teacher

Be concise and specific.`;

    const aiText = await callGemini(prompt);
    const risk   = pct < 60 ? 'HIGH' : pct < 75 ? 'MEDIUM' : 'LOW';

    res.json({
      student: { name: student.name, roll_no: student.roll_no },
      stats:   { percentage: pct, total_days: days.length, present_days: present, suspicious_attempts: suspicious?.count || 0 },
      risk_level: risk,
      ai_analysis: aiText,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai/homework-help
router.post('/homework-help', authMiddleware, async (req, res) => {
  try {
    const { question, subject } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'Question required' });

    const prompt = `You are a helpful academic tutor for Indian school/college students.
Subject: ${subject || 'General'}
Student question: ${question}

Provide a clear, educational answer. If it's a math/science problem, show step-by-step solution.
Keep the language simple and easy to understand.`;

    const answer = await callGemini(prompt);
    res.json({ question, subject, answer });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai/report-comment
router.post('/report-comment', authMiddleware, teacherOnly, async (req, res) => {
  try {
    const { student_name, percentage, grade, subjects } = req.body;

    const prompt = `Write a professional report card comment for an Indian school student.
Student: ${student_name}
Overall Grade: ${grade}
Attendance: ${percentage}%
Subjects: ${subjects || 'N/A'}

Write 2-3 sentences of teacher's comment. Be encouraging but honest. Professional tone.`;

    const comment = await callGemini(prompt);
    res.json({ comment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;