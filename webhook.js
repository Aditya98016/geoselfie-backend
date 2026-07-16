/*
 * © 2026 GeoSelfie — Razorpay Webhook Handler
 * Add to server.js: app.use('/api/webhook', require('./webhook'))
 */
const express = require('express')
const crypto  = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { dbGet, dbRun } = require('./database')

const router           = express.Router()
const WEBHOOK_SECRET   = process.env.RAZORPAY_WEBHOOK_SECRET || ''
const processedEvents  = new Set() // Idempotency — deduplicate events

// IMPORTANT: Raw body needed for signature verification
// In server.js, add BEFORE express.json():
// app.use('/api/webhook/razorpay', express.raw({ type: 'application/json' }))

router.post('/razorpay', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature']
    const body      = req.body

    // 1. Verify webhook signature
    if (WEBHOOK_SECRET && signature) {
      const expectedSig = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(body)
        .digest('hex')
      if (expectedSig !== signature) {
        console.error('[Webhook] Invalid signature')
        return res.status(400).json({ error: 'Invalid signature' })
      }
    }

    const event = JSON.parse(body.toString())
    const eventId = event.id || `${event.event}_${Date.now()}`

    // 2. Idempotency — skip duplicate events
    if (processedEvents.has(eventId)) {
      console.log('[Webhook] Duplicate event skipped:', eventId)
      return res.json({ status: 'duplicate_skipped' })
    }
    processedEvents.add(eventId)
    // Cleanup old event IDs (keep last 1000)
    if (processedEvents.size > 1000) {
      const iter = processedEvents.values()
      processedEvents.delete(iter.next().value)
    }

    console.log('[Webhook] Event received:', event.event)

    switch (event.event) {

      case 'payment.captured': {
        const payment   = event.payload?.payment?.entity
        const orderId   = payment?.order_id
        const paymentId = payment?.id

        if (!orderId || !paymentId) break

        // Find pending payment
        const pending = dbGet('SELECT * FROM payments WHERE razorpay_order_id=?', [orderId])
        if (!pending || pending.status === 'paid') break

        // Activate subscription
       const { PLANS } = require('./subscription')
        const planInfo  = PLANS[pending.plan]
        if (!planInfo) break

        const now       = new Date()
        const expiresAt = new Date(now.getTime() + planInfo.days*24*60*60*1000).toISOString()

        dbRun(`UPDATE subscriptions SET plan=?,status='active',is_active=1,started_at=?,expires_at=?,
               razorpay_payment_id=?,razorpay_order_id=?,updated_at=? WHERE teacher_id=?`,
          [pending.plan, now.toISOString(), expiresAt, paymentId, orderId, now.toISOString(), pending.teacher_id])

        dbRun('UPDATE payments SET status=?,razorpay_payment_id=? WHERE razorpay_order_id=?',
          ['paid', paymentId, orderId])

        // Create invoice
        const teacher = dbGet('SELECT * FROM users WHERE id=?', [pending.teacher_id])
        const college = dbGet('SELECT college_name FROM classes WHERE class_code=?', [teacher?.class_code])
        const y       = now.getFullYear()
        const count   = (dbGet('SELECT COUNT(*) as c FROM invoices')?.c || 0) + 1
        const invNum  = `GSI-${y}-${String(count).padStart(5,'0')}`
        const tax     = Math.round(planInfo.price * 0.18 * 100) / 100
        const total   = planInfo.price + tax

        dbRun(`INSERT OR IGNORE INTO invoices
          (id,invoice_number,teacher_id,class_code,college_name,teacher_name,teacher_email,
           plan,plan_label,duration_days,amount,tax_amount,total_amount,currency,
           razorpay_order_id,razorpay_payment_id,payment_status,invoice_date,valid_from,valid_until,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), invNum, pending.teacher_id, teacher?.class_code||null, college?.college_name||'',
           teacher?.name||'', teacher?.email||'', pending.plan, pending.plan, planInfo.days,
           planInfo.price, tax, total, 'INR', orderId, paymentId, 'paid',
           now.toLocaleDateString('en-IN'), now.toISOString(), expiresAt, now.toISOString()])

        // Notify teacher via socket
        if (global.io) {
          global.io.to('user_'+pending.teacher_id).emit('subscription_activated', {
            plan: pending.plan, days: planInfo.days, expires_at: expiresAt
          })
        }

        console.log(`[Webhook] Subscription activated for teacher: ${pending.teacher_id}`)
        break
      }

      case 'payment.failed': {
        const payment = event.payload?.payment?.entity
        const orderId = payment?.order_id
        if (orderId) {
          dbRun('UPDATE payments SET status=? WHERE razorpay_order_id=?', ['failed', orderId])
        }
        console.log('[Webhook] Payment failed for order:', orderId)
        break
      }

      case 'subscription.activated':
      case 'subscription.charged': {
        console.log('[Webhook] Subscription event:', event.event)
        break
      }

      default:
        console.log('[Webhook] Unhandled event:', event.event)
    }

    res.json({ status: 'ok', event: event.event })
  } catch(e) {
    console.error('[Webhook] Error:', e.message)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

module.exports = router