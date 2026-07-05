/*
 * © 2026 GeoSelfie — All rights reserved.
 * Multi-Account Switcher API
 */
const express = require('express');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();

// POST /api/accounts/save — Save account to device switcher
router.post('/save', authMiddleware, (req, res) => {
  const { device_id, avatar_color } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Device ID required' });

  const user    = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user)    return res.status(404).json({ error: 'User not found' });

  // Generate fresh token for this account
  const token = jwt.sign(
    { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code },
    process.env.JWT_SECRET, { expiresIn:'30d' }
  );

  const existing = dbGet('SELECT id FROM saved_accounts WHERE device_id=? AND user_id=?', [device_id, user.id]);
  if (existing) {
    dbRun('UPDATE saved_accounts SET token=?, name=?, last_used=? WHERE id=?',
      [token, user.name, new Date().toISOString(), existing.id]);
  } else {
    dbRun(`INSERT INTO saved_accounts (id, device_id, user_id, name, email, role, class_code, token, avatar_color, last_used, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), device_id, user.id, user.name, user.email, user.role, user.class_code||null,
       token, avatar_color||'#1A56DB', new Date().toISOString(), new Date().toISOString()]);
  }

  res.json({ message: 'Account saved to switcher', token });
});

// GET /api/accounts/list/:deviceId — List all saved accounts on device
router.get('/list/:deviceId', (req, res) => {
  const accounts = dbAll(`
    SELECT sa.id, sa.user_id, sa.name, sa.email, sa.role, sa.class_code,
           sa.avatar_color, sa.last_used, sa.token,
           s.status as sub_status, s.plan as sub_plan, s.expires_at as sub_expires
    FROM saved_accounts sa
    LEFT JOIN subscriptions s ON s.teacher_id = sa.user_id
    WHERE sa.device_id = ?
    ORDER BY sa.last_used DESC
  `, [req.params.deviceId]);

  // Validate each token
  const valid = accounts.map(acc => {
    try {
      jwt.verify(acc.token, process.env.JWT_SECRET);
      return { ...acc, token_valid: true };
    } catch {
      return { ...acc, token_valid: false };
    }
  });

  res.json({ accounts: valid });
});

// POST /api/accounts/switch — Switch to another account
router.post('/switch', (req, res) => {
  const { device_id, user_id } = req.body;
  if (!device_id || !user_id) return res.status(400).json({ error: 'device_id and user_id required' });

  const saved = dbGet('SELECT * FROM saved_accounts WHERE device_id=? AND user_id=?', [device_id, user_id]);
  if (!saved) return res.status(404).json({ error: 'Account not found on this device' });

  // Validate token
  try { jwt.verify(saved.token, process.env.JWT_SECRET); }
  catch {
    // Refresh token
    const user = dbGet('SELECT * FROM users WHERE id=?', [user_id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newToken = jwt.sign(
      { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code },
      process.env.JWT_SECRET, { expiresIn:'30d' }
    );
    dbRun('UPDATE saved_accounts SET token=?, last_used=? WHERE id=?', [newToken, new Date().toISOString(), saved.id]);
    saved.token = newToken;
  }

  const user = dbGet('SELECT id,name,email,phone,role,roll_no,class_code,unique_code,parent_code,email_verified,language FROM users WHERE id=?', [user_id]);
  dbRun('UPDATE saved_accounts SET last_used=? WHERE id=?', [new Date().toISOString(), saved.id]);
  dbRun('UPDATE users SET is_online=1, last_seen=? WHERE id=?', [new Date().toISOString(), user_id]);

  res.json({ message: 'Switched successfully', token: saved.token, user });
});

// DELETE /api/accounts/remove — Remove account from switcher
router.delete('/remove', authMiddleware, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Device ID required' });
  dbRun('DELETE FROM saved_accounts WHERE device_id=? AND user_id=?', [device_id, req.user.id]);
  res.json({ message: 'Account removed from switcher' });
});

// PUT /api/accounts/refresh-token — Refresh token for saved account
router.put('/refresh-token', (req, res) => {
  const { device_id, user_id, password } = req.body;
  if (!device_id||!user_id) return res.status(400).json({ error: 'device_id and user_id required' });
  const user = dbGet('SELECT * FROM users WHERE id=?', [user_id]);
  if (!user)  return res.status(404).json({ error: 'User not found' });
  const newToken = jwt.sign(
    { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code },
    process.env.JWT_SECRET, { expiresIn:'30d' }
  );
  dbRun('UPDATE saved_accounts SET token=?, last_used=? WHERE device_id=? AND user_id=?',
    [newToken, new Date().toISOString(), device_id, user_id]);
  res.json({ token: newToken });
});

module.exports = router;