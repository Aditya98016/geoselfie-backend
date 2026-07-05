/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 4: Razorpay real payment integration
 */
const express  = require('express');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();

const PLANS = {
  monthly:   { label:'1 Month',  days:30,  price:299  },
  quarterly: { label:'3 Months', days:90,  price:799  },
  biannual:  { label:'6 Months', days:180, price:1499 },
  annual:    { label:'1 Year',   days:365, price:2499 },
};

// POST /api/payment/create-order
router.post('/create-order', authMiddleware, teacherOnly, async (req, res) => {
  try {
    const { plan } = req.body;
    const planInfo = PLANS[plan];
    if (!planInfo) return res.status(400).json({ error: 'Invalid plan' });

    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

console.log('Razorpay Key:', keyId); // debug ke liye

if (!keyId || !keySecret) {
  return res.status(400).json({
    error: 'Razorpay not configured'
  });
}

const receiptId = `geo_${req.user.id.slice(0, 8)}_${Date.now()}`;
const authStr = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${authStr}`,
      },
      body: JSON.stringify({
        amount:   planInfo.price * 100,
        currency: 'INR',
        receipt:  receiptId,
        notes:    {
          teacher_id:   req.user.id,
          plan,
          teacher_name: req.user.name,
        }
      }),
    });

    const order = await response.json();

    if (!response.ok) {
      throw new Error(order.error?.description || 'Razorpay order creation failed');
    }

    // Pending payment save karo
    dbRun(`INSERT OR REPLACE INTO payments
           (id, teacher_id, razorpay_order_id, plan, amount, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [uuidv4(), req.user.id, order.id, plan, planInfo.price, new Date().toISOString()]);

    const teacher = dbGet('SELECT email, phone FROM users WHERE id=?', [req.user.id]);

    res.json({
      order_id:     order.id,
      amount:       planInfo.price * 100,
      currency:     'INR',
      key_id:       keyId,
      plan,
      plan_label:   planInfo.label,
      teacher_name: req.user.name,
      teacher_email:teacher?.email || '',
      teacher_phone:teacher?.phone || '',
    });
  } catch(e) {
    console.error('Create order error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/verify
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan
    } = req.body;

    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    // Signature verify
    const body      = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected  = crypto
      .createHmac('sha256', keySecret)
      .update(body)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed — invalid signature' });
    }

    const planInfo  = PLANS[plan];
    if (!planInfo) return res.status(400).json({ error: 'Invalid plan' });

    const expires   = new Date(Date.now() + planInfo.days * 24 * 60 * 60 * 1000).toISOString();
    const teacherId = req.user.id;
    const nowISO    = new Date().toISOString();

    // Subscription activate karo
    const existing = dbGet('SELECT id FROM subscriptions WHERE teacher_id=?', [teacherId]);
    if (existing) {
      dbRun(`UPDATE subscriptions
             SET plan=?, status='active', started_at=?, expires_at=?, payment_id=?, amount=?
             WHERE teacher_id=?`,
        [plan, nowISO, expires, razorpay_payment_id, planInfo.price, teacherId]);
    } else {
      dbRun(`INSERT INTO subscriptions
             (id, teacher_id, plan, status, started_at, expires_at, payment_id, amount, created_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        [uuidv4(), teacherId, plan, nowISO, expires, razorpay_payment_id, planInfo.price, nowISO]);
    }

    // Payment record update karo
    dbRun(`UPDATE payments SET status='success', razorpay_payment_id=? WHERE razorpay_order_id=?`,
      [razorpay_payment_id, razorpay_order_id]);

    const teacher = dbGet('SELECT name, email FROM users WHERE id=?', [teacherId]);

    res.json({
      success:    true,
      message:    'Payment successful! Subscription activated.',
      expires_at: expires,
      plan,
      bill: {
        bill_id:       `BILL-${Date.now()}`,
        payment_id:    razorpay_payment_id,
        order_id:      razorpay_order_id,
        teacher_name:  teacher?.name,
        teacher_email: teacher?.email,
        plan:          planInfo.label,
        amount:        planInfo.price,
        gst:           Math.round(planInfo.price * 0.18),
        total:         Math.round(planInfo.price * 1.18),
        valid_from:    nowISO,
        valid_till:    expires,
        date:          new Date().toLocaleDateString('en-IN'),
      }
    });
  } catch(e) {
    console.error('Verify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payment/invoice/:paymentId
router.get('/invoice/:paymentId', authMiddleware, (req, res) => {
  try {
    const payment = dbGet('SELECT * FROM payments WHERE razorpay_payment_id=?', [req.params.paymentId]);
    if (!payment || payment.teacher_id !== req.user.id)
      return res.status(403).json({ error: 'Invoice not found' });

    const teacher  = dbGet('SELECT * FROM users WHERE id=?', [payment.teacher_id]);
    const sub      = dbGet('SELECT * FROM subscriptions WHERE teacher_id=?', [payment.teacher_id]);
    const planInfo = PLANS[payment.plan] || { label: payment.plan };
    const gst      = Math.round(payment.amount * 0.18);
    const total    = payment.amount + gst;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invoice — GeoSelfie</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,Arial,sans-serif;background:#F8FAFC;color:#0F172A;padding:40px 20px}
    .inv{max-width:680px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#1A56DB,#059669);padding:32px 40px;display:flex;justify-content:space-between;align-items:flex-start;color:#fff}
    .logo{font-size:26px;font-weight:800;letter-spacing:-1px}
    .inv-info{text-align:right}
    .inv-info h2{font-size:22px;font-weight:800}
    .inv-info p{font-size:12px;opacity:.8;margin-top:4px}
    .body{padding:36px 40px}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-bottom:28px}
    .sec-title{font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
    .info p{font-size:14px;color:#475569;line-height:1.8}
    .info strong{color:#0F172A}
    table{width:100%;border-collapse:collapse;margin-bottom:20px}
    th{background:#F1F5F9;padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px}
    td{padding:14px;border-bottom:1px solid #E2E8F0;font-size:14px;color:#475569}
    .amt{text-align:right;font-weight:600}
    .total-row td{background:#F8FAFC;font-weight:700;color:#0F172A}
    .grand td{background:#1A56DB;color:#fff;font-size:15px;font-weight:800}
    .stamp{display:inline-block;border:3px solid #059669;color:#059669;border-radius:12px;padding:8px 20px;font-size:18px;font-weight:800;transform:rotate(-5deg);letter-spacing:2px;margin:16px 0}
    .badge{display:inline-block;background:#ECFDF5;color:#059669;border:1px solid rgba(5,150,105,.2);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;margin-right:8px}
    .ftr{border-top:1px solid #E2E8F0;padding:20px 40px;text-align:center}
    .ftr p{font-size:12px;color:#94A3B8;margin-top:4px}
    .print-btn{margin-top:14px;padding:10px 24px;background:#1A56DB;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer}
    @media print{body{background:#fff;padding:0}.inv{box-shadow:none}.print-btn{display:none}}
  </style>
</head>
<body>
<div class="inv">
  <div class="hdr">
    <div>
      <div class="logo">GeoSelfie</div>
      <div style="font-size:12px;opacity:.8;margin-top:4px">Smart Presence, Verified</div>
    </div>
    <div class="inv-info">
      <h2>TAX INVOICE</h2>
      <p>Invoice #: BILL-${payment.id?.slice(0,8)?.toUpperCase()}</p>
      <p>Date: ${new Date(payment.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</p>
      <p>Payment ID: ${req.params.paymentId}</p>
    </div>
  </div>
  <div class="body">
    <div class="row2">
      <div class="info">
        <p class="sec-title">Billed To</p>
        <p><strong>${teacher?.name || 'N/A'}</strong></p>
        <p>${teacher?.email || 'N/A'}</p>
        <p>${teacher?.phone || 'N/A'}</p>
        <p>Class Code: <strong>${teacher?.class_code || 'N/A'}</strong></p>
      </div>
      <div class="info">
        <p class="sec-title">From</p>
        <p><strong>GeoSelfie — Geo Selfie Identity</strong></p>
        <p>support@geoselfie.in</p>
        <p>grievance@geoselfie.in</p>
        <p style="margin-top:8px;font-size:12px;color:#94A3B8">GSTIN: Applied for</p>
      </div>
    </div>
    <table>
      <thead>
        <tr><th>Description</th><th>Plan</th><th>Duration</th><th class="amt">Amount</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>GeoSelfie Teacher Subscription</td>
          <td><span style="background:#EBF2FF;color:#1A56DB;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:700">${planInfo.label}</span></td>
          <td>${sub?.started_at ? new Date(sub.started_at).toLocaleDateString('en-IN') : ''} → ${sub?.expires_at ? new Date(sub.expires_at).toLocaleDateString('en-IN') : ''}</td>
          <td class="amt">₹${payment.amount}</td>
        </tr>
        <tr class="total-row"><td colspan="3" style="text-align:right">Subtotal</td><td class="amt">₹${payment.amount}</td></tr>
        <tr class="total-row"><td colspan="3" style="text-align:right">GST @ 18%</td><td class="amt">₹${gst}</td></tr>
        <tr class="grand"><td colspan="3" style="text-align:right">TOTAL AMOUNT PAID</td><td class="amt">₹${total}</td></tr>
      </tbody>
    </table>
    <div style="text-align:center"><div class="stamp">✓ PAID</div></div>
    <div style="margin-top:16px">
      <span class="badge">✓ DPDP Act 2023</span>
      <span class="badge">✓ Secured by Razorpay</span>
      <span class="badge">✓ Students Free</span>
    </div>
  </div>
  <div class="ftr">
    <p>Thank you for subscribing to GeoSelfie!</p>
    <p>Computer-generated invoice — no signature required.</p>
    <p style="margin-top:6px"><strong>© 2026 GeoSelfie — Geo Selfie Identity · All rights reserved.</strong></p>
    <button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
  </div>
</div>
</body>
</html>`);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payment/history
router.get('/history', authMiddleware, (req, res) => {
  try {
    const payments = dbAll(
      'SELECT * FROM payments WHERE teacher_id=? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ payments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;