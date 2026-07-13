/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 9: Persistent notification badge system
 */
const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { dbGet, dbRun, dbAll } = require('./database')
const { authMiddleware } = require('./middleware')

const router = express.Router()

// Create notification (used by other modules)
function createNotification(userId, type, title, body, module_, refId) {
  try {
    const id = uuidv4()
    dbRun(`INSERT INTO notifications
      (id,user_id,type,title,body,module,ref_id,is_read,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`,
      [id, userId, type, title, body || '', module_ || '', refId || null, new Date().toISOString()])

    // Push via socket
    if (global.io) {
      global.io.to('user_' + userId).emit('new_notification', {
        id, type, title, body, module: module_, ref_id: refId
      })
    }
    return id
  } catch(e) {
    console.error('createNotification error:', e.message)
  }
}

// Create notification for all users in a class
function createClassNotification(classCode, role, type, title, body, module_, refId, excludeId) {
  try {
    const { dbAll } = require('./database')
    let users = dbAll(
      'SELECT id FROM users WHERE class_code=? AND role=?',
      [classCode, role]
    )
    users.forEach(u => {
      if (u.id !== excludeId) {
        createNotification(u.id, type, title, body, module_, refId)
      }
    })
  } catch(e) {
    console.error('createClassNotification error:', e.message)
  }
}

// GET /api/notifications/all — with unread counts per module
router.get('/all', authMiddleware, (req, res) => {
  try {
    const notifications = dbAll(
      'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    )

    // Unread count per module
    const moduleCounts  = {}
    let totalUnread     = 0
    notifications.forEach(n => {
      if (!n.is_read) {
        totalUnread++
        moduleCounts[n.module] = (moduleCounts[n.module] || 0) + 1
      }
    })

    res.json({ notifications, total_unread: totalUnread, module_counts: moduleCounts })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/notifications/unread-count
router.get('/unread-count', authMiddleware, (req, res) => {
  try {
    const result = dbGet(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id=? AND is_read=0',
      [req.user.id]
    )
    const moduleCounts = {}
    const rows = dbAll(
      'SELECT module, COUNT(*) as count FROM notifications WHERE user_id=? AND is_read=0 GROUP BY module',
      [req.user.id]
    )
    rows.forEach(r => { moduleCounts[r.module] = r.count })

    res.json({ total_unread: result?.count || 0, module_counts: moduleCounts })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/notifications/mark-read
router.post('/mark-read', authMiddleware, (req, res) => {
  try {
    const { ids, module: mod } = req.body
    if (ids && ids.length > 0) {
      ids.forEach(id => {
        dbRun('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', [id, req.user.id])
      })
    } else if (mod) {
      dbRun('UPDATE notifications SET is_read=1 WHERE user_id=? AND module=?', [req.user.id, mod])
    }
    res.json({ success: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/notifications/mark-all-read
router.post('/mark-all-read', authMiddleware, (req, res) => {
  try {
    dbRun('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id])
    res.json({ success: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = { router, createNotification, createClassNotification }