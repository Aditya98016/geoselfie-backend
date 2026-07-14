/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 2+3: Razorpay + Legal Invoice
 */
const express  = require('express')
const crypto   = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { dbGet, dbRun, dbAll } = require('./database')
const { authMiddleware, teacherOnly } = require('./middleware')
const { PLANS } = require('./subscription')

const router = express.Router()

const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID     || ''
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || ''

function getInvoiceNumber() {
  const y   = new Date().getFullYear()
  const count = dbGet('SELECT COUNT(*) as c FROM invoices')?.c || 0
  return 'GSI-' + y + '-' + String(count + 1).padStart(5, '0')
}

// POST /api/payment/create-order
router.post('/create-order', authMiddleware, teacherOnly, async (req, res) => {
  try {
    const { plan } = req.body
    const planInfo = PLANS[plan]
    if (!planInfo) return res.status(400).json({ error: 'Invalid plan' })
    if (plan === 'trial') return res.status(400).json({ error: 'Trial is free, no payment needed' })

    const teacher = dbGet('SELECT * FROM users WHERE id=?', [req.user.id])
    const college = dbGet('SELECT college_name FROM classes WHERE class_code=?', [teacher?.class_code])

    // Create Razorpay order
    const orderPayload = {
      amount:   planInfo.price * 100, // paise
      currency: 'INR',
      receipt:  'GSI_' + Date.now(),
      notes:    { teacher_id: req.user.id, plan, teacher_name: teacher?.name || '' }
    }

    let orderId = 'ORDER_' + Date.now() // fallback for dev

    if (RZP_KEY_ID && RZP_KEY_SECRET) {
      try {
        const Razorpay = require('razorpay')
        const rzp      = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
        const order    = await rzp.orders.create(orderPayload)
        orderId        = order.id
      } catch(e) {
        console.warn('Razorpay order creation failed:', e.message)
        // Continue with fallback orderId for testing
      }
    }

    // Save pending payment
    dbRun(`INSERT OR REPLACE INTO payments
      (id,teacher_id,razorpay_order_id,plan,amount,currency,status,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(), req.user.id, orderId, plan, planInfo.price, 'INR', 'pending', new Date().toISOString()])

    res.json({
      order_id:     orderId,
      amount:       planInfo.price * 100,
      currency:     'INR',
      key_id:       RZP_KEY_ID,
      plan,
      plan_label:   planInfo.label,
      teacher_name: teacher?.name || '',
      teacher_email:teacher?.email || '',
      college_name: college?.college_name || '',
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/payment/verify
router.post('/verify', authMiddleware, teacherOnly, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body
    const planInfo = PLANS[plan]
    if (!planInfo) return res.status(400).json({ error: 'Invalid plan' })

    // Verify signature
    if (RZP_KEY_SECRET && razorpay_signature) {
      const body = razorpay_order_id + '|' + razorpay_payment_id
      const expectedSig = crypto
        .createHmac('sha256', RZP_KEY_SECRET)
        .update(body)
        .digest('hex')
      if (expectedSig !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment signature verification failed' })
      }
    }

    // Update payment
    dbRun('UPDATE payments SET status=?, razorpay_payment_id=? WHERE razorpay_order_id=?',
      ['paid', razorpay_payment_id, razorpay_order_id])

    // Activate subscription
    const now       = new Date()
    const expiresAt = new Date(now.getTime() + planInfo.days * 24 * 60 * 60 * 1000)

    dbRun(`UPDATE subscriptions SET
      plan=?, status='active', is_active=1, starts_at=?, expires_at=?, days_left=?,
      razorpay_payment_id=?, razorpay_order_id=?, updated_at=?
      WHERE teacher_id=?`,
      [plan, now.toISOString(), expiresAt.toISOString(), planInfo.days,
       razorpay_payment_id, razorpay_order_id, now.toISOString(), req.user.id])

    // FIX 3: Generate invoice
    const teacher     = dbGet('SELECT * FROM users WHERE id=?', [req.user.id])
    const college     = dbGet('SELECT * FROM classes WHERE class_code=?', [teacher?.class_code])
    const invoiceNum  = getInvoiceNumber()
    const taxAmount   = Math.round(planInfo.price * 0.18 * 100) / 100 // 18% GST
    const totalAmount = planInfo.price + taxAmount
    const invId       = uuidv4()

    dbRun(`INSERT INTO invoices
      (id,invoice_number,teacher_id,class_code,college_name,teacher_name,teacher_email,
       plan,plan_label,duration_days,amount,tax_amount,total_amount,currency,
       razorpay_order_id,razorpay_payment_id,payment_status,invoice_date,valid_from,valid_until,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [invId, invoiceNum, req.user.id, teacher?.class_code,
       college?.college_name || '', teacher?.name || '', teacher?.email || '',
       plan, planInfo.label, planInfo.days, planInfo.price, taxAmount, totalAmount, 'INR',
       razorpay_order_id, razorpay_payment_id, 'paid',
       now.toLocaleDateString('en-IN'), now.toISOString(), expiresAt.toISOString(),
       now.toISOString()])

    // Notification
    dbRun(`INSERT INTO notifications (id,user_id,type,title,body,module,is_read,created_at)
           VALUES (?,?,'payment','Payment Successful',?,  'subscription',0,?)`,
      [uuidv4(), req.user.id,
       planInfo.label + ' activated! Invoice: ' + invoiceNum,
       now.toISOString()])

    // Emit subscription activated
    if (global.io) {
      global.io.to('user_' + req.user.id).emit('subscription_activated', {
        plan, days: planInfo.days, expires_at: expiresAt.toISOString(), invoice_number: invoiceNum
      })
    }

    const invoice = dbGet('SELECT * FROM invoices WHERE id=?', [invId])
    res.json({
      success:      true,
      message:      'Payment verified and subscription activated!',
      invoice_id:   invId,
      invoice_number: invoiceNum,
      invoice,
      expires_at:   expiresAt.toISOString(),
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/payment/invoices
router.get('/invoices', authMiddleware, teacherOnly, (req, res) => {
  try {
    const invoices = dbAll(
      'SELECT * FROM invoices WHERE teacher_id=? ORDER BY created_at DESC',
      [req.user.id]
    )
    res.json({ invoices })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// GET /api/payment/invoice-html/:id — FIX 3: Downloadable HTML invoice
router.get('/invoice-html/:id', authMiddleware, (req, res) => {
  try {
    const inv = dbGet('SELECT * FROM invoices WHERE id=? AND teacher_id=?',
      [req.params.id, req.user.id])
    if (!inv) return res.status(404).json({ error: 'Invoice not found' })

    const validFrom  = inv.valid_from  ? new Date(inv.valid_from).toLocaleDateString('en-IN')  : 'N/A'
    const validUntil = inv.valid_until ? new Date(inv.valid_until).toLocaleDateString('en-IN') : 'N/A'

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Invoice ${inv.invoice_number}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; color:#0F172A; background:#fff; padding:30px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:30px; border-bottom:3px solid #1A56DB; padding-bottom:20px; }
  .brand { font-size:28px; font-weight:900; }
  .brand span:first-child { color:#1A56DB; }
  .brand span:last-child  { color:#059669; }
  .invoice-info h1 { font-size:22px; color:#1A56DB; }
  .invoice-info p  { font-size:13px; color:#475569; margin-top:4px; }
  .section { margin:24px 0; }
  .section h3 { font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:#475569; margin-bottom:10px; }
  .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  .detail-box { background:#F8FAFC; border:1px solid #E2E8F0; border-radius:10px; padding:14px; }
  .detail-box p { font-size:13px; color:#475569; margin-bottom:3px; }
  .detail-box strong { font-size:14px; color:#0F172A; }
  table { width:100%; border-collapse:collapse; }
  th { background:#1A56DB; color:#fff; padding:10px 14px; text-align:left; font-size:13px; }
  td { padding:10px 14px; border-bottom:1px solid #E2E8F0; font-size:13px; }
  .total-row td { font-weight:700; font-size:15px; background:#ECFDF5; color:#059669; }
  .footer { margin-top:30px; text-align:center; color:#94A3B8; font-size:11px; border-top:1px solid #E2E8F0; padding-top:16px; }
  .badge { display:inline-block; background:#ECFDF5; color:#059669; border:1px solid rgba(5,150,105,.25); border-radius:6px; padding:3px 10px; font-size:12px; font-weight:700; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand"><span>Geo</span><span>Selfie</span></div>
      <p style="font-size:12px;color:#475569;margin-top:4px;">Smart Presence, Verified</p>
      <p style="font-size:11px;color:#94A3B8;margin-top:2px;">© 2026 GeoSelfie — Geo Selfie Identity</p>
    </div>
    <div class="invoice-info" style="text-align:right;">
      <h1>TAX INVOICE</h1>
      <p><strong>${inv.invoice_number}</strong></p>
      <p>Date: ${inv.invoice_date}</p>
      <span class="badge">✓ PAID</span>
    </div>
  </div>

  <div class="grid-2">
    <div class="detail-box">
      <h3>Billed To</h3>
      <p>Name</p><strong>${inv.teacher_name}</strong><br><br>
      <p>Email</p><strong>${inv.teacher_email}</strong><br><br>
      <p>College</p><strong>${inv.college_name || 'N/A'}</strong>
    </div>
    <div class="detail-box">
      <h3>Payment Details</h3>
      <p>Order ID</p><strong style="font-size:11px;font-family:monospace">${inv.razorpay_order_id || 'N/A'}</strong><br><br>
      <p>Payment ID</p><strong style="font-size:11px;font-family:monospace">${inv.razorpay_payment_id || 'N/A'}</strong><br><br>
      <p>Valid</p><strong>${validFrom} → ${validUntil}</strong>
    </div>
  </div>

  <div class="section">
    <table>
      <tr>
        <th>Description</th>
        <th>Duration</th>
        <th>Amount (INR)</th>
      </tr>
      <tr>
        <td>GeoSelfie ${inv.plan_label} Subscription</td>
        <td>${inv.duration_days} Days</td>
        <td>₹${inv.amount.toFixed(2)}</td>
      </tr>
      <tr>
        <td>GST @ 18%</td>
        <td></td>
        <td>₹${inv.tax_amount.toFixed(2)}</td>
      </tr>
      <tr class="total-row">
        <td colspan="2">Total Amount Paid</td>
        <td>₹${inv.total_amount.toFixed(2)}</td>
      </tr>
    </table>
  </div>

  <div class="footer">
    <p>This is a computer-generated invoice and does not require a signature.</p>
    <p style="margin-top:6px;">GeoSelfie Technology · support@geoselfie.app · www.geoselfie.app</p>
    <p style="margin-top:4px;">GSTIN: 10AAAAA0000A1Z5 (Placeholder — update with real GSTIN)</p>
  </div>
</body>
</html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_number}.html"`)
    res.send(html)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router