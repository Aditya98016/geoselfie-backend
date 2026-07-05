/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 * Real-time Socket.IO for GeoChat
 */
const jwt = require('jsonwebtoken');
const { dbRun, dbGet } = require('./database');

function setupSocket(io) {
  global.io = io;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch { next(new Error('Invalid token')); }
  });

  io.on('connection', socket => {
    const userId    = socket.user?.id;
    const classCode = socket.user?.class_code;

    console.log(`🔗 Connected: ${socket.user?.name} [${socket.user?.role}]`);

    // Update online status
    dbRun('UPDATE users SET is_online = 1 WHERE id = ?', [userId]);

    // Join class room
    if (classCode) socket.join(`class_${classCode}`);

    // Join personal room
    socket.join(`user_${userId}`);

    // Typing indicator
    socket.on('typing', ({ chat_id, is_typing }) => {
      socket.to(chat_id).emit('user_typing', {
        user_id: userId,
        name: socket.user?.name,
        chat_id,
        is_typing
      });
    });

    // Join chat room
    socket.on('join_chat', chat_id => {
      socket.join(chat_id);
    });

    // Leave chat room
    socket.on('leave_chat', chat_id => {
      socket.leave(chat_id);
    });

    // Mark message read
    socket.on('mark_read', ({ message_id }) => {
      const { v4: uuidv4 } = require('uuid');
      dbRun('INSERT OR IGNORE INTO message_reads (id, message_id, user_id, read_at) VALUES (?, ?, ?, ?)',
        [uuidv4(), message_id, userId, new Date().toISOString()]);
    });

    // Online status broadcast
    socket.to(`class_${classCode}`).emit('user_online', { user_id: userId, is_online: true });

    // Disconnect
    socket.on('disconnect', () => {
      const lastSeen = new Date().toISOString();
      dbRun('UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?', [lastSeen, userId]);
      socket.to(`class_${classCode}`).emit('user_online', { user_id: userId, is_online: false, last_seen: lastSeen });
      console.log(`❌ Disconnected: ${socket.user?.name}`);
    });
  });
}

module.exports = setupSocket;