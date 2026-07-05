/*
 * © 2026 GeoSelfie — All rights reserved.
 * AI Features powered by Google Gemini
 */
const express = require('express');
const { dbGet, dbAll } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();

async function callGemini(prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
        })
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI';
  } catch(e) {
    console.error('Gemini API error:', e.message);
    return null;
  }
}

// GET /api/ai/attendance-insights
router.get('/attendance-insights', authMiddleware, teacherOnly, async (req, res) => {
  const classCode = req.user.class_code;
  const students  = dbAll('SELECT id, name FROM users WHERE role = ? AND class_code = ?', ['student', classCode]);
  const stats     = students.map(s => {
    const history = dbAll('SELECT status FROM attendance_sessions WHERE student_id = ? ORDER BY date DESC LIMIT 30', [s.id]);
    const present = history.filter(h=>h.status==='present').length;
    return { name: s.name, pct: history.length ? Math.round((present/history.length)*100) : 0, days: history.length };
  });

  const low       = stats.filter(s=>s.pct<75);
  const avg       = stats.length ? Math.round(stats.reduce((a,s)=>a+s.pct,0)/stats.length) : 0;
  const classInfo = dbGet('SELECT college_name FROM classes WHERE class_code = ?', [classCode]);

  const prompt = `You are an attendance analytics AI for GeoSelfie app.
Class: ${classInfo?.college_name||classCode}
Total Students: ${stats.length}
Average Attendance: ${avg}%
Students below 75%: ${low.map(s=>`${s.name} (${s.pct}%)`).join(', ')||'None'}
Top Students: ${stats.filter(s=>s.pct>=90).map(s=>s.name).join(', ')||'None'}

Provide a brief 3-point analysis:
1. Overall class health
2. At-risk students
3. One actionable recommendation
Keep it concise and practical.`;

  const insight = await callGemini(prompt);

  res.json({
    stats: { total: stats.length, avg_pct: avg, below_75: low.length, above_90: stats.filter(s=>s.pct>=90).length },
    at_risk: low,
    ai_insight: insight || 'AI analysis unavailable. Check GEMINI_API_KEY in .env'
  });
});

// GET /api/ai/student-risk/:id
router.get('/student-risk/:id', authMiddleware, teacherOnly, async (req, res) => {
  const student = dbGet('SELECT name, roll_no FROM users WHERE id = ?', [req.params.id]);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const history  = dbAll('SELECT date, status FROM attendance_sessions WHERE student_id = ? ORDER BY date DESC LIMIT 30', [req.params.id]);
  const marks    = dbAll('SELECT marks_obtained, total_marks FROM marks WHERE student_id = ?', [req.params.id]);
  const present  = history.filter(h=>h.status==='present').length;
  const attPct   = history.length ? Math.round((present/history.length)*100) : 0;
  const avgMarks = marks.length ? marks.reduce((s,m)=>s+(m.marks_obtained/m.total_marks*100),0)/marks.length : null;

  const prompt = `Student Risk Analysis for GeoSelfie:
Student: ${student.name} (Roll: ${student.roll_no||'N/A'})
Attendance: ${attPct}% (${present}/${history.length} days)
Average Marks: ${avgMarks ? Math.round(avgMarks)+'%' : 'No exams yet'}
Recent trend: ${history.slice(0,7).map(h=>h.status==='present'?'P':'A').join('')}
Rate risk level (Low/Medium/High) and give 2 specific recommendations. Be brief.`;

  const analysis = await callGemini(prompt);
  res.json({ student, attendance_pct: attPct, risk_level: attPct<60?'High':attPct<75?'Medium':'Low', ai_analysis: analysis||'AI unavailable' });
});

// POST /api/ai/report-comment
router.post('/report-comment', authMiddleware, teacherOnly, async (req, res) => {
  const { student_name, attendance_pct, avg_marks, grade } = req.body;
  const prompt = `Write a brief professional teacher's comment for a student report card.
Student: ${student_name}, Attendance: ${attendance_pct}%, Average Marks: ${avg_marks}%, Grade: ${grade}
Write 2-3 sentences. Be encouraging but honest.`;
  const comment = await callGemini(prompt);
  res.json({ comment: comment||'Unable to generate comment' });
});

// POST /api/ai/homework-help
router.post('/homework-help', authMiddleware, async (req, res) => {
  const { question, subject } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const prompt = `You are a helpful academic assistant. Subject: ${subject||'General'}\nStudent question: ${question}\nProvide a clear educational answer. Guide understanding rather than just giving answers. Be concise.`;
  const answer = await callGemini(prompt);
  res.json({ answer: answer||'AI unavailable. Check GEMINI_API_KEY.' });
});

module.exports = router;