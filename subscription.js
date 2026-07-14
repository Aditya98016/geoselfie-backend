/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 1: Subscription blocking + trial once + backend validation
 */
const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { dbGet, dbRun, dbAll } = require('./database')
const { authMiddleware, teacherOnly } = require('./middleware')

const router = express.Router()

const PLANS = {
  trial:     { label:'Free Trial',  days:30,  price:0,    tax:0    },
  monthly:   { label:'1 Month',     days:30,  price:299,  tax:0    },
  quarterly: { label:'3 Months',    days:90,  price:799,  tax:0    },
  biannual:  { label:'6 Months',    days:180, price:1499, tax:0    },
  annual:    { label:'1 Year',      days:365, price:2499, tax:0    },
}

function createTrialSubscription(teacherId) {
  const existing = dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [teacherId])
  if (existing) return existing

  const id  = uuidv4()
  const now = new Date().toISOString()
  dbRun(`INSERT INTO subscriptions
    (id,teacher_id,plan,status,is_active,trial_used,started_at,expires_at,days_left,created_at)
    VALUES (?,?,'none','inactive',0,0,NULL,NULL,0,?)`,
    [id, teacherId, now])
  return dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [teacherId])
}

// FIX 1: GET /api/subscription/status — Always from DB, never trust client
router.get('/status', authMiddleware, (req, res) => {
  try {
    let sub = dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [req.user.id])
    if (!sub) sub = createTrialSubscription(req.user.id)

    const now     = new Date()
    let isActive  = false
    let daysLeft  = 0

    if (sub.expires_at) {
      const exp = new Date(sub.expires_at)
      daysLeft  = Math.max(0, Math.ceil((exp - now) / (1000 * 60 * 60 * 24)))
      isActive  = daysLeft > 0
    }

    // Auto-expire in DB if needed
    if (sub.is_active && !isActive && sub.expires_at) {
      dbRun('UPDATE subscriptions SET is_active=0, status=? WHERE teacher_id=?',
        ['expired', req.user.id])
      sub.is_active = 0
      sub.status    = 'expired'
    }

    res.json({
      subscription: {
        ...sub,
        is_active:  isActive ? 1 : 0,
        days_left:  daysLeft,
        trial_used: sub.trial_used || 0,
      },
      plans:       PLANS,
      needs_sub:   !isActive,
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// FIX 1: POST /api/subscription/activate
router.post('/activate', authMiddleware, teacherOnly, (req, res) => {
  try {
    const { plan, payment_id, order_id } = req.body
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' })

    const planInfo  = PLANS[plan]
    const teacherId = req.user.id

    let sub = dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [teacherId])
    if (!sub) sub = createTrialSubscription(teacherId)

    // FIX 1: Trial can only be used ONCE — check DB
    if (plan === 'trial') {
      if (sub.trial_used) {
        return res.status(400).json({
          error: 'Free Trial already used. Please choose a paid plan.',
          trial_used: true,
        })
      }
    }

    const now       = new Date()
    const expiresAt = new Date(now.getTime() + planInfo.days * 24 * 60 * 60 * 1000)

    dbRun(`UPDATE subscriptions SET
      plan=?, status='active', is_active=1,
      trial_used=CASE WHEN ? = 'trial' THEN 1 ELSE trial_used END,
      started_at=?, expires_at=?, days_left=?,
      razorpay_payment_id=?, razorpay_order_id=?,
      updated_at=?
      WHERE teacher_id=?`,
      [plan, plan, now.toISOString(), expiresAt.toISOString(), planInfo.days,
       payment_id || null, order_id || null, now.toISOString(), teacherId])

    // Create notification
    dbRun(`INSERT INTO notifications (id,user_id,type,title,body,module,is_read,created_at)
           VALUES (?,?,'subscription','Subscription Activated',?,  'subscription',0,?)`,
      [uuidv4(), teacherId,
       planInfo.label + ' activated! Valid until ' + expiresAt.toLocaleDateString('en-IN'),
       now.toISOString()])

    const updated = dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [teacherId])

    res.json({
      success:      true,
      message:      planInfo.label + ' activated successfully!',
      subscription: updated,
      expires_at:   expiresAt.toISOString(),
      days:         planInfo.days,
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = { router, createTrialSubscription, PLANS }