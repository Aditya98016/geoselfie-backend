/*
 * © 2026 GeoSelfie — All rights reserved.
 * Feedback + Support Ticket System
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');
const { sendSupportTicketEmail } = require('./mailer');

const router = express.Router();
const nowISO = () => new Date().toISOString();

function generateTicketNumber() {
  const date = new Date();
  const dd   = String(date.getDate()).padStart(2,'0');
  const mm   = String(date.getMonth()+1).padStart(2,'0');
  const yy   = String(date.getFullYear()).slice(-2);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `GS-${yy}${mm}${dd}-${rand}`;
}

// POST /api/feedback/submit
router.post('/submit', (req, res) => {
  try {
    const { name, email, role, category, message, user_id } = req.body;
    if (!name || !role || !category || !message)
      return res.status(400).json({ error: 'Name, role, category, and message are required' });

    const id = uuidv4();
    dbRun(`INSERT INTO feedback (id, user_id, name, email, role, category, message, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [id, user_id||null, name, email||null, role, category, message, nowISO()]);

    res.status(201).json({ message: 'Feedback submitted! Thank you.', id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/feedback/list — Admin only
router.get('/list', authMiddleware, (req, res) => {
  try {
    const { category, status, page = 1 } = req.query;
    let sql    = 'SELECT * FROM feedback WHERE 1=1';
    const params = [];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    if (status)   { sql += ' AND status = ?';   params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT 50 OFFSET ?';
    params.push((parseInt(page)-1)*50);
    const items = dbAll(sql, params);
    const total = dbGet('SELECT COUNT(*) as count FROM feedback', []);
    res.json({ feedback: items, total: total?.count||0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/feedback/ticket — Support Ticket
router.post('/ticket', async (req, res) => {
  try {
    const { name, email, role, subject, description, priority = 'medium', user_id } = req.body;
    if (!name || !email || !subject || !description)
      return res.status(400).json({ error: 'Name, email, subject, and description are required' });

    const id           = uuidv4();
    const ticketNumber = generateTicketNumber();

    dbRun(`INSERT INTO support_tickets
           (id, user_id, name, email, role, subject, description, priority, status, ticket_number, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [id, user_id||null, name, email, role||'general', subject, description, priority, ticketNumber, nowISO()]);

    await sendSupportTicketEmail(email, ticketNumber, subject);

    res.status(201).json({
      message: 'Support ticket raised! You will receive a confirmation email.',
      ticket_number: ticketNumber,
      id,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/feedback/tickets — List tickets (admin)
router.get('/tickets', authMiddleware, (req, res) => {
  try {
    const { status, priority, page = 1 } = req.query;
    let sql    = 'SELECT * FROM support_tickets WHERE 1=1';
    const params = [];
    if (status)   { sql += ' AND status = ?';   params.push(status); }
    if (priority) { sql += ' AND priority = ?'; params.push(priority); }
    sql += ' ORDER BY created_at DESC LIMIT 50 OFFSET ?';
    params.push((parseInt(page)-1)*50);
    const items = dbAll(sql, params);
    res.json({ tickets: items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/feedback/my-ticket/:ticketNumber — User apna ticket dekhe
router.get('/my-ticket/:ticketNumber', (req, res) => {
  try {
    const ticket = dbGet('SELECT id, ticket_number, subject, description, priority, status, admin_reply, created_at FROM support_tickets WHERE ticket_number = ?',
      [req.params.ticketNumber]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/feedback/ticket/:id/reply — Admin reply
router.put('/ticket/:id/reply', authMiddleware, (req, res) => {
  try {
    const { reply, status = 'resolved' } = req.body;
    dbRun('UPDATE support_tickets SET admin_reply=?, status=?, resolved_at=? WHERE id=?',
      [reply, status, nowISO(), req.params.id]);
    res.json({ message: 'Reply sent!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/feedback/faqs — FAQs
router.get('/faqs', (req, res) => {
  res.json({
    faqs: [
      { q:'How does geo-selfie attendance work?', a:'The app verifies your location using GPS to confirm you are on campus, then asks you to take a selfie for liveness check. Both must pass for attendance to be marked.' },
      { q:'What if I am marked absent even though I was present?', a:'You can raise a correction request from the Attendance section. Your teacher will review and approve it.' },
      { q:'How do I get my class code?', a:'Ask your teacher. They received it upon registration. It looks like GS-XXXX.' },
      { q:'Can I use GeoSelfie on multiple devices?', a:'Yes! Your account works on unlimited devices simultaneously. Just login with your credentials on any device.' },
      { q:'What is my unique code?', a:'It is a personal login shortcut (STU-XXXXXXXX for students, PAR-XXXXXXXX for parents). You can find it in your Profile screen.' },
      { q:'How does parent access work?', a:'Parents register using their child\'s unique STU code. They can then see attendance, homework, notices, and chat with teachers.' },
      { q:'Is my data safe?', a:'Yes. We are fully DPDP Act 2023 compliant. Your selfie and GPS are deleted within 60 seconds. Attendance records are kept for 1 academic year.' },
      { q:'Why is my subscription showing expired?', a:'Teacher subscriptions expire after the chosen period. Go to Profile → Manage Subscription to renew.' },
      { q:'How do I report a bug?', a:'Go to Profile → Support → Raise a Ticket. Our team responds within 24 hours.' },
      { q:'What languages does GeoSelfie support?', a:'English, Hindi, Bengali, Marathi, Tamil, and Telugu.' },
    ]
  });
});

module.exports = router;