/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();

// Send push notification via Expo
async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken || !pushToken.startsWith('ExponentPushToken')) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default' })
    });
  } catch(e) { console.error('Push notification error:', e.message); }
}

// Send to class
async function notifyClass(classCode, title, body, type, excludeId = null) {
  const users = dbAll(
    'SELECT id, push_token FROM users WHERE class_code = ? AND id != ?',
    [classCode, excludeId || '']
  );
  for (const user of users) {
    if (user.push_token) await sendPushNotification(user.push_token, title, body, { type });
    dbRun('INSERT INTO push_logs (id, user_id, title, body, type, sent_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), user.id, title, body, type, new Date().toISOString(), 'sent']);
  }
}

// POST /api/notifications/register-token
router.post('/register-token', authMiddleware, (req, res) => {
  const { push_token } = req.body;
  if (!push_token) return res.status(400).json({ error: 'Push token required' });
  dbRun('UPDATE users SET push_token = ? WHERE id = ?', [push_token, req.user.id]);
  res.json({ message: 'Push token registered!' });
});

// POST /api/notifications/send-verify-alert
router.post('/send-verify-alert', async (req, res) => {
  const { studentIds, classCode } = req.body;
  const students = studentIds
    ? dbAll(`SELECT push_token FROM users WHERE id IN (${studentIds.map(()=>'?').join(',')})`, studentIds)
    : dbAll('SELECT push_token FROM users WHERE class_code = ? AND role = ?', [classCode, 'student']);

  for (const s of students) {
    if (s.push_token) {
      await sendPushNotification(s.push_token, '📸 Verify Attendance', 'Take a selfie now to verify your attendance!', { type: 'verify' });
    }
  }
  res.json({ message: 'Alerts sent!' });
});

module.exports = { router, sendPushNotification, notifyClass };