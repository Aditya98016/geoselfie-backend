/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: File sharing, group chats, parent info header
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// File upload for chat
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// GET /api/chat/list
router.get('/list', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const chats  = dbAll(`
      SELECT
        c.*,
        cm.role as my_role,
        (SELECT content FROM messages WHERE chat_id=c.id AND is_deleted=0 ORDER BY sent_at DESC LIMIT 1) as last_message,
        (SELECT sent_at FROM messages WHERE chat_id=c.id AND is_deleted=0 ORDER BY sent_at DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE chat_id=c.id AND is_deleted=0
         AND id NOT IN (SELECT message_id FROM message_reads WHERE user_id=?)) as unread_count
      FROM chats c
      JOIN chat_members cm ON cm.chat_id=c.id AND cm.user_id=?
      ORDER BY last_message_time DESC NULLS LAST
    `, [userId, userId]);

    // Enrich with other user info for direct chats
    const enriched = chats.map(chat => {
      if (chat.type === 'direct') {
        const other = dbGet(`
          SELECT u.id, u.name, u.role, u.is_online, u.email, u.phone, u.roll_no, u.class_code
          FROM chat_members cm
          JOIN users u ON u.id = cm.user_id
          WHERE cm.chat_id=? AND cm.user_id!=?
          LIMIT 1
        `, [chat.id, userId]);

        // FIX: Parent chat — child info
        let childInfo = null;
        if (other?.role === 'parent') {
          const student = dbGet(
            'SELECT id, name, roll_no, class_code, unique_code FROM users WHERE parent_code=? AND role=?',
            [other.unique_code || '', 'student']
          ) || dbGet(
            'SELECT id, name, roll_no, class_code, unique_code FROM users WHERE class_code=? AND role=? LIMIT 1',
            [other.class_code || '', 'student']
          );
          childInfo = student;
        }

        return { ...chat, other_user: other || null, child_info: childInfo };
      }
      return chat;
    });

    res.json({ chats: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/create-direct
router.post('/create-direct', authMiddleware, (req, res) => {
  try {
    const { other_user_id } = req.body;
    if (!other_user_id) return res.status(400).json({ error: 'other_user_id required' });

    // Check if already exists
    const existing = dbGet(`
      SELECT c.id FROM chats c
      JOIN chat_members cm1 ON cm1.chat_id=c.id AND cm1.user_id=?
      JOIN chat_members cm2 ON cm2.chat_id=c.id AND cm2.user_id=?
      WHERE c.type='direct' LIMIT 1
    `, [req.user.id, other_user_id]);

    if (existing) return res.json({ chat_id: existing.id, existing: true });

    const chatId = uuidv4();
    dbRun('INSERT INTO chats (id,type,created_by,created_at) VALUES (?,"direct",?,?)',
      [chatId, req.user.id, nowISO()]);
    dbRun('INSERT INTO chat_members (id,chat_id,user_id,joined_at) VALUES (?,?,?,?)',
      [uuidv4(), chatId, req.user.id, nowISO()]);
    dbRun('INSERT INTO chat_members (id,chat_id,user_id,joined_at) VALUES (?,?,?,?)',
      [uuidv4(), chatId, other_user_id, nowISO()]);

    res.json({ chat_id: chatId, existing: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/create-group — FIX: teacher-students, teacher-parents groups
router.post('/create-group', authMiddleware, (req, res) => {
  try {
    const { name, member_ids, type = 'group' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Group name required' });

    const chatId = uuidv4();
    dbRun('INSERT INTO chats (id,type,name,class_code,created_by,created_at) VALUES (?,?,?,?,?,?)',
      [chatId, type, name.trim(), req.user.class_code, req.user.id, nowISO()]);

    // Add creator
    dbRun('INSERT INTO chat_members (id,chat_id,user_id,role,joined_at) VALUES (?,?,?,"admin",?)',
      [uuidv4(), chatId, req.user.id, nowISO()]);

    // Add members
    const members = member_ids || [];
    members.forEach(uid => {
      if (uid !== req.user.id) {
        const exists = dbGet('SELECT id FROM chat_members WHERE chat_id=? AND user_id=?', [chatId, uid]);
        if (!exists) {
          dbRun('INSERT INTO chat_members (id,chat_id,user_id,joined_at) VALUES (?,?,?,?)',
            [uuidv4(), chatId, uid, nowISO()]);
        }
      }
    });

    res.json({ chat_id: chatId, name: name.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/create-class-groups — auto create student+parent groups
router.post('/create-class-groups', authMiddleware, (req, res) => {
  try {
    const classCode = req.user.class_code;
    if (!classCode) return res.status(400).json({ error: 'No class code' });

    const students = dbAll('SELECT id FROM users WHERE class_code=? AND role=?', [classCode, 'student']);
    const parents  = dbAll('SELECT id FROM users WHERE class_code=? AND role=?', [classCode, 'parent']);

    // Students group
    const studGroupName = `Class ${classCode} — Students`;
    let studGroup = dbGet('SELECT id FROM chats WHERE name=? AND class_code=?', [studGroupName, classCode]);
    if (!studGroup) {
      const gid = uuidv4();
      dbRun('INSERT INTO chats (id,type,name,class_code,created_by,created_at) VALUES (?,"group",?,?,?,?)',
        [gid, studGroupName, classCode, req.user.id, nowISO()]);
      dbRun('INSERT INTO chat_members (id,chat_id,user_id,role,joined_at) VALUES (?,?,?,"admin",?)',
        [uuidv4(), gid, req.user.id, nowISO()]);
      students.forEach(s => {
        dbRun('INSERT OR IGNORE INTO chat_members (id,chat_id,user_id,joined_at) VALUES (?,?,?,?)',
          [uuidv4(), gid, s.id, nowISO()]);
      });
      studGroup = { id: gid };
    }

    // Parents group
    const parGroupName = `Class ${classCode} — Parents`;
    let parGroup = dbGet('SELECT id FROM chats WHERE name=? AND class_code=?', [parGroupName, classCode]);
    if (!parGroup) {
      const gid = uuidv4();
      dbRun('INSERT INTO chats (id,type,name,class_code,created_by,created_at) VALUES (?,"group",?,?,?,?)',
        [gid, parGroupName, classCode, req.user.id, nowISO()]);
      dbRun('INSERT INTO chat_members (id,chat_id,user_id,role,joined_at) VALUES (?,?,?,"admin",?)',
        [uuidv4(), gid, req.user.id, nowISO()]);
      parents.forEach(p => {
        dbRun('INSERT OR IGNORE INTO chat_members (id,chat_id,user_id,joined_at) VALUES (?,?,?,?)',
          [uuidv4(), gid, p.id, nowISO()]);
      });
      parGroup = { id: gid };
    }

    res.json({
      students_group: studGroup.id,
      parents_group:  parGroup.id,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/messages/:chatId
router.get('/messages/:chatId', authMiddleware, (req, res) => {
  try {
    const { page = 1 } = req.query;
    const offset  = (parseInt(page) - 1) * 50;
    const messages = dbAll(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id=?
      ORDER BY m.sent_at ASC
      LIMIT 50 OFFSET ?
    `, [req.params.chatId, offset]);

    // Mark as read
    messages.forEach(msg => {
      if (msg.sender_id !== req.user.id) {
        dbRun('INSERT OR IGNORE INTO message_reads (id,message_id,user_id,read_at) VALUES (?,?,?,?)',
          [uuidv4(), msg.id, req.user.id, nowISO()]);
      }
    });

    const total = dbGet('SELECT COUNT(*) as count FROM messages WHERE chat_id=?', [req.params.chatId]);
    res.json({ messages, total: total?.count || 0, page: parseInt(page) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/send
router.post('/send', authMiddleware, (req, res) => {
  try {
    const { chat_id, content, type = 'text', reply_to } = req.body;
    if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
    if (!content?.trim() && type === 'text')
      return res.status(400).json({ error: 'Content required' });

    // Verify member
    const member = dbGet('SELECT id FROM chat_members WHERE chat_id=? AND user_id=?',
      [chat_id, req.user.id]);
    if (!member) return res.status(403).json({ error: 'Not a member of this chat' });

    const id  = uuidv4();
    const now = nowISO();
    dbRun(`INSERT INTO messages
           (id,chat_id,sender_id,type,content,reply_to,sent_at)
           VALUES (?,?,?,?,?,?,?)`,
      [id, chat_id, req.user.id, type, content?.trim()||null, reply_to||null, now]);

    const message = dbGet(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
    `, [id]);

    // Socket emit
    if (global.io) {
      global.io.to(`chat_${chat_id}`).emit('new_message', message);
    }

    res.json({ message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/send-file — FIX: file sharing
router.post('/send-file', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File required' });
    const { chat_id } = req.body;
    if (!chat_id) return res.status(400).json({ error: 'chat_id required' });

    const member = dbGet('SELECT id FROM chat_members WHERE chat_id=? AND user_id=?',
      [chat_id, req.user.id]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const ext      = path.extname(req.file.originalname).toLowerCase();
    const fileUrl  = `/uploads/chat/${req.file.filename}`;
    const fileType = req.file.mimetype;
    const isImage  = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext);
    const isVideo  = ['.mp4','.mov','.avi','.mkv'].includes(ext);
    const isAudio  = ['.mp3','.wav','.m4a','.ogg'].includes(ext);
    const type     = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file';

    const id  = uuidv4();
    const now = nowISO();
    dbRun(`INSERT INTO messages
           (id,chat_id,sender_id,type,content,file_url,file_name,file_size,sent_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, chat_id, req.user.id, type,
       req.file.originalname, fileUrl, req.file.originalname,
       req.file.size, now]);

    const message = dbGet(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
    `, [id]);

    if (global.io) {
      global.io.to(`chat_${chat_id}`).emit('new_message', message);
    }

    res.json({ message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/class-members
router.get('/class-members', authMiddleware, (req, res) => {
  try {
    const members = dbAll(
      `SELECT id, name, role, is_online, email FROM users WHERE class_code=? AND id!=? ORDER BY role, name`,
      [req.user.class_code, req.user.id]
    );
    res.json({ members });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;