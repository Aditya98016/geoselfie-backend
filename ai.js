/*
 * © 2026 GeoSelfie — All rights reserved.
 * AI — Gemini API integration
 */
const express = require('express')
const { dbGet, dbAll } = require('./database')
const { authMiddleware } = require('./middleware')

const router = express.Router()

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
  return 'AI insights not available — Gemini API key not configured.'
}
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type':'application/json' },
        body:    JSON.stringify({ contents:[{ parts:[{ text:prompt }] }] })
      }
    )
    const data = await resp.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI'
  } catch(e) {
    console.error('Gemini error:', e.message)
    return 'AI temporarily unavailable.'
  }
}

// GET /api/ai/attendance-insights
router.get('/attendance-insights', authMiddleware, async (req, res) => {
  try {
    const classCode = req.user.class_code
    const students  = dbAll(`SELECT u.name,
      (SELECT COUNT(*) FROM attendance_sessions WHERE student_id=u.id AND status='present') as p,
      (SELECT COUNT(*) FROM attendance_sessions WHERE student_id=u.id) as t
      FROM users u WHERE u.class_code=? AND u.role='student'`, [classCode])

    const summary = students.map(s => {
      const pct = s.t>0 ? Math.round((s.p/s.t)*100) : 0
      return `${s.name}: ${pct}% (${s.p}/${s.t} days)`
    }).join('\n')

    const prompt = `You are an educational analytics AI. Analyze this attendance data and provide actionable insights in 3-5 bullet points. Be concise and helpful for teachers.\n\nAttendance Summary:\n${summary}\n\nProvide insights about:\n1. Students at risk (<75%)\n2. Overall class health\n3. Recommendations`

    const insight = await callGemini(prompt)
    res.json({ insight })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ai/homework-help
router.post('/homework-help', authMiddleware, async (req, res) => {
  try {
    const { question, subject = 'General' } = req.body
    if (!question?.trim()) return res.status(400).json({ error:'Question required' })

    const prompt = `You are a helpful educational assistant for Indian students. Answer this ${subject} question clearly and educationally. Be concise (max 200 words).\n\nQuestion: ${question}`
    const answer = await callGemini(prompt)
    res.json({ answer })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/ai/student-risk
router.get('/student-risk', authMiddleware, async (req, res) => {
  try {
    const classCode = req.user.class_code
    const atRisk    = dbAll(`SELECT u.name,u.email,
      (SELECT COUNT(*) FROM attendance_sessions WHERE student_id=u.id AND status='present') as p,
      (SELECT COUNT(*) FROM attendance_sessions WHERE student_id=u.id) as t
      FROM users u WHERE u.class_code=? AND u.role='student'
      HAVING t>5 AND (p*100/t)<75`, [classCode])

    res.json({ at_risk:atRisk, count:atRisk.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/ai/report-comment
router.post('/report-comment', authMiddleware, async (req, res) => {
  try {
    const { student_name, attendance_pct, avg_marks_pct, grade } = req.body
    const prompt = `Generate a professional teacher's comment for a student report card (max 3 sentences). Be encouraging but honest.\n\nStudent: ${student_name}\nAttendance: ${attendance_pct}%\nAcademic Average: ${avg_marks_pct}%\nGrade: ${grade}`
    const comment = await callGemini(prompt)
    res.json({ comment })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router