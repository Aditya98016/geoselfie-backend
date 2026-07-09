/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Real-time chat auto refresh
 */
const jwt = require('jsonwebtoken');

module.exports = function setupSocket(io) {
  global.io = io;

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('No token'));
      const user = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = user;
      next();
    } catch(e) { next(new Error('Invalid token')); }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`Socket connected: ${user?.name} (${user?.role})`);

    // Join class room
    if (user?.class_code) {
      socket.join(`class_${user.class_code}`);
    }

    // Join personal room
    socket.join(`user_${user?.id}`);

    // Join chat rooms
    socket.on('join_chat', (chatId) => {
      socket.join(`chat_${chatId}`);
    });

    socket.on('leave_chat', (chatId) => {
      socket.leave(`chat_${chatId}`);
    });

    // Typing indicator
    socket.on('typing', ({ chatId, typing }) => {
      socket.to(`chat_${chatId}`).emit('typing', {
        user_id: user?.id,
        name:    user?.name,
        typing,
      });
    });

    // Mark read
    socket.on('mark_read', ({ chatId }) => {
      socket.to(`chat_${chatId}`).emit('message_read', { user_id: user?.id });
    });

    // Online status
    if (user?.id) {
      const { dbRun } = require('./database');
      dbRun('UPDATE users SET is_online=1, last_seen=? WHERE id=?',
        [new Date().toISOString(), user.id]);
      io.emit('user_status', { user_id: user.id, online: true });
    }

    socket.on('disconnect', () => {
      if (user?.id) {
        const { dbRun } = require('./database');
        dbRun('UPDATE users SET is_online=0, last_seen=? WHERE id=?',
          [new Date().toISOString(), user.id]);
        io.emit('user_status', { user_id: user.id, online: false });
      }
      console.log(`Socket disconnected: ${user?.name}`);
    });
  });
};