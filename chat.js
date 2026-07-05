/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 * GeoChat — WhatsApp Style Messaging
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/chat';
    require('fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// GET /api/chat/list — all chats
router.get('/list', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const chats  = dbAll(`
    SELECT c.*, cm.is_pinned,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender_id != ? AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = ?)) as unread_count,
      (SELECT content FROM messages WHERE chat_id = c.id ORDER BY sent_at DESC LIMIT 1) as last_message,
      (SELECT sent_at FROM messages WHERE chat_id = c.id ORDER BY sent_at DESC LIMIT 1) as last_message_time,
      (SELECT sender_id FROM messages WHERE chat_id = c.id ORDER BY sent_at DESC LIMIT 1) as last_sender_id
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
    ORDER BY cm.is_pinned DESC, last_message_time DESC
  `, [userId, userId, userId]);

  // For direct chats, get other person's info
  const enriched = chats.map(chat => {
    if (chat.type === 'direct') {
      const other = dbAll(`SELECT u.id, u.name, u.avatar, u.is_online, u.last_seen FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? AND cm.user_id != ?`, [chat.id, userId]);
      return { ...chat, other_user: other[0] || null };
    }
    return chat;
  });

  res.json({ chats: enriched });
});

// POST /api/chat/create-direct — direct chat banao
router.post('/create-direct', authMiddleware, (req, res) => {
  const { other_user_id } = req.body;
  const userId            = req.user.id;

  // Already exists?
  const existing = dbGet(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct' LIMIT 1
  `, [userId, other_user_id]);

  if (existing) return res.json({ chat_id: existing.id, already_exists: true });

  const chatId = uuidv4();
  dbRun(`INSERT INTO chats (id, type, created_by, created_at) VALUES (?, 'direct', ?, ?)`, [chatId, userId, nowISO()]);
  dbRun(`INSERT INTO chat_members (id, chat_id, user_id, joined_at) VALUES (?, ?, ?, ?)`, [uuidv4(), chatId, userId, nowISO()]);
  dbRun(`INSERT INTO chat_members (id, chat_id, user_id, joined_at) VALUES (?, ?, ?, ?)`, [uuidv4(), chatId, other_user_id, nowISO()]);

  res.json({ chat_id: chatId, already_exists: false });
});

// POST /api/chat/create-group — group chat banao
router.post('/create-group', authMiddleware, (req, res) => {
  const { name, member_ids, is_broadcast = false } = req.body;
  const userId = req.user.id;

  const chatId = uuidv4();
  dbRun(`INSERT INTO chats (id, type, name, created_by, is_broadcast, class_code, created_at) VALUES (?, 'group', ?, ?, ?, ?, ?)`,
    [chatId, name, userId, is_broadcast ? 1 : 0, req.user.class_code, nowISO()]);

  // Add creator as admin
  dbRun(`INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)`, [uuidv4(), chatId, userId, nowISO()]);

  // Add members
  (member_ids || []).forEach(memberId => {
    if (memberId !== userId) {
      dbRun(`INSERT OR IGNORE INTO chat_members (id, chat_id, user_id, joined_at) VALUES (?, ?, ?, ?)`, [uuidv4(), chatId, memberId, nowISO()]);
    }
  });

  res.json({ chat_id: chatId, message: 'Group created!' });
});

// GET /api/chat/messages/:chatId — messages laao
router.get('/messages/:chatId', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  // Check member
  const isMember = dbGet('SELECT id FROM chat_members WHERE chat_id = ? AND user_id = ?', [req.params.chatId, userId]);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this chat' });

  const messages = dbAll(`
    SELECT m.*, u.name as sender_name, u.avatar as sender_avatar,
      (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id) as read_count
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? AND m.is_deleted = 0
    ORDER BY m.sent_at DESC LIMIT ? OFFSET ?
  `, [req.params.chatId, parseInt(limit), parseInt(offset)]);

  // Mark as read
  messages.forEach(msg => {
    if (msg.sender_id !== userId) {
      const alreadyRead = dbGet('SELECT id FROM message_reads WHERE message_id = ? AND user_id = ?', [msg.id, userId]);
      if (!alreadyRead) {
        dbRun(`INSERT OR IGNORE INTO message_reads (id, message_id, user_id, read_at) VALUES (?, ?, ?, ?)`,
          [uuidv4(), msg.id, userId, nowISO()]);
      }
    }
  });

  res.json({ messages: messages.reverse() });
});

// POST /api/chat/send — message bhejo
router.post('/send', authMiddleware, (req, res) => {
  const { chat_id, content, type = 'text', reply_to, forwarded_from } = req.body;
  const userId = req.user.id;

  const isMember = dbGet('SELECT id FROM chat_members WHERE chat_id = ? AND user_id = ?', [chat_id, userId]);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });

  const msgId = uuidv4();
  dbRun(`INSERT INTO messages (id, chat_id, sender_id, type, content, reply_to, forwarded_from, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [msgId, chat_id, userId, type, content, reply_to||null, forwarded_from||null, nowISO()]);

  const msg = dbGet('SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?', [msgId]);

  // Emit via socket if available
  if (global.io) {
    global.io.to(chat_id).emit('new_message', msg);
  }

  res.json({ message: msg });
});

// POST /api/chat/send-file — file bhejo
router.post('/send-file', authMiddleware, upload.single('file'), (req, res) => {
  const { chat_id, type = 'image' } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileUrl  = `/uploads/chat/${req.file.filename}`;
  const msgId    = uuidv4();

  dbRun(`INSERT INTO messages (id, chat_id, sender_id, type, file_url, file_name, file_size, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [msgId, chat_id, req.user.id, type, fileUrl, req.file.originalname, req.file.size, nowISO()]);

  const msg = dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);

  if (global.io) global.io.to(chat_id).emit('new_message', msg);

  res.json({ message: msg, file_url: fileUrl });
});

// DELETE /api/chat/message/:id
router.delete('/message/:id', authMiddleware, (req, res) => {
  const msg = dbGet('SELECT sender_id FROM messages WHERE id = ?', [req.params.id]);
  if (!msg || msg.sender_id !== req.user.id)
    return res.status(403).json({ error: 'Cannot delete this message' });

  dbRun('UPDATE messages SET is_deleted = 1, content = NULL WHERE id = ?', [req.params.id]);
  res.json({ message: 'Message deleted' });
});

// POST /api/chat/pin/:chatId — chat pin karo
router.post('/pin/:chatId', authMiddleware, (req, res) => {
  const current = dbGet('SELECT is_pinned FROM chat_members WHERE chat_id = ? AND user_id = ?', [req.params.chatId, req.user.id]);
  const newPin  = current?.is_pinned ? 0 : 1;
  dbRun('UPDATE chat_members SET is_pinned = ? WHERE chat_id = ? AND user_id = ?', [newPin, req.params.chatId, req.user.id]);
  res.json({ pinned: newPin === 1 });
});

// GET /api/chat/search — message search
router.get('/search', authMiddleware, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });

  const results = dbAll(`
    SELECT m.*, c.name as chat_name, u.name as sender_name
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN users u ON u.id = m.sender_id
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
    WHERE m.content LIKE ? AND m.is_deleted = 0
    ORDER BY m.sent_at DESC LIMIT 20
  `, [req.user.id, `%${q}%`]);

  res.json({ results });
});

// GET /api/chat/class-members — class ke sab members
router.get('/class-members', authMiddleware, (req, res) => {
  const members = dbAll(
    'SELECT id, name, avatar, role, is_online, last_seen FROM users WHERE class_code = ? AND id != ? ORDER BY role, name',
    [req.user.class_code, req.user.id]
  );
  res.json({ members });
});

module.exports = router;