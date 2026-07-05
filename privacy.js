/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Privacy Policy, T&C, Data Deletion all working
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// PUBLIC — no auth needed
router.get('/policy-page', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GeoSelfie — Privacy Policy</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,system-ui,sans-serif;background:#F1F5F9;color:#0F172A;line-height:1.6;padding:20px}
    .container{max-width:720px;margin:0 auto}
    .header{text-align:center;padding:32px;background:#fff;border-radius:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
    h1{font-size:28px;font-weight:800}
    h1 .b{color:#1A56DB} h1 .g{color:#059669}
    .badge{display:inline-block;background:#ECFDF5;color:#059669;border:1px solid rgba(5,150,105,.2);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;margin-top:8px}
    .sec{background:#fff;border-radius:14px;padding:24px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
    h2{font-size:15px;font-weight:700;color:#1A56DB;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #E2E8F0}
    p,li{font-size:14px;color:#475569;margin-bottom:6px}
    li{margin-left:20px}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th{background:#F1F5F9;padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase}
    td{padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#475569}
    .yes{color:#DC2626;font-weight:600} .no{color:#059669;font-weight:600}
    .contact{background:#EBF2FF;border:1px solid rgba(26,86,219,.2);border-radius:10px;padding:14px}
    .contact a{color:#1A56DB;font-weight:600}
    .footer{text-align:center;font-size:12px;color:#94A3B8;margin-top:20px;padding:16px}
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><span class="b">Geo</span><span class="g">Selfie</span></h1>
    <p style="color:#475569;margin-top:4px">Smart Presence, Verified</p>
    <div class="badge">DPDP Act 2023 Compliant</div>
    <p style="font-size:12px;color:#94A3B8;margin-top:8px">Privacy Policy · Last Updated: June 2026</p>
  </div>

  <div class="sec">
    <h2>1. Introduction</h2>
    <p>GeoSelfie is committed to protecting your privacy in compliance with the <strong>Digital Personal Data Protection Act 2023 (DPDP Act), India</strong>. This policy explains what data we collect, why, and how we protect it.</p>
  </div>

  <div class="sec">
    <h2>2. Data We Collect</h2>
    <table>
      <tr><th>Data Type</th><th>Purpose</th><th>Stored</th><th>Retention</th></tr>
      <tr><td>Live Selfie</td><td>Liveness verification</td><td class="no">NO</td><td>Deleted in 60s</td></tr>
      <tr><td>GPS Location</td><td>Campus presence</td><td class="no">NO</td><td>Deleted in 60s</td></tr>
      <tr><td>Attendance Records</td><td>Academic records</td><td class="yes">YES</td><td>1 academic year</td></tr>
      <tr><td>Email & Name</td><td>Authentication</td><td class="yes">YES</td><td>Until deletion</td></tr>
      <tr><td>Phone Number</td><td>OTP & alerts</td><td class="yes">YES</td><td>Until deletion</td></tr>
      <tr><td>Chat Messages</td><td>Communication</td><td class="yes">YES</td><td>Until deletion</td></tr>
    </table>
  </div>

  <div class="sec">
    <h2>3. What We Do NOT Do</h2>
    <ul>
      <li>We do NOT sell your data to any third party</li>
      <li>We do NOT track your location in background</li>
      <li>We do NOT use your data for advertising</li>
      <li>We do NOT store raw selfies or GPS permanently</li>
    </ul>
  </div>

  <div class="sec">
    <h2>4. Your Rights under DPDP Act 2023</h2>
    <ul>
      <li><strong>Right to Access</strong> — View your personal data anytime</li>
      <li><strong>Right to Correct</strong> — Request correction of inaccurate data</li>
      <li><strong>Right to Erase</strong> — Request deletion (processed within 30 days)</li>
      <li><strong>Right to Withdraw Consent</strong> — Stop attendance tracking</li>
      <li><strong>Right to Grieve</strong> — File a complaint with us</li>
    </ul>
  </div>

  <div class="sec">
    <h2>5. Contact & Grievance</h2>
    <div class="contact">
      <p><strong>Data Protection Officer:</strong> <a href="mailto:dpo@geoselfie.in">dpo@geoselfie.in</a></p>
      <p><strong>Grievance Officer:</strong> <a href="mailto:grievance@geoselfie.in">grievance@geoselfie.in</a></p>
      <p style="margin-top:8px;font-size:12px;color:#94A3B8">Response: 72 hours · Resolution: 30 days</p>
    </div>
  </div>

  <div class="footer">
    <p>© 2026 GeoSelfie — Geo Selfie Identity · All rights reserved.</p>
    <p style="margin-top:4px">DPDP Act 2023 Compliant · Made in India 🇮🇳</p>
  </div>
</div>
</body></html>`);
});

// PUBLIC — Terms & Conditions
router.get('/terms', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GeoSelfie — Terms & Conditions</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,system-ui,sans-serif;background:#F1F5F9;color:#0F172A;line-height:1.6;padding:20px}
    .container{max-width:720px;margin:0 auto}
    .header{text-align:center;padding:32px;background:#fff;border-radius:16px;margin-bottom:16px}
    h1{font-size:28px;font-weight:800}
    h1 .b{color:#1A56DB} h1 .g{color:#059669}
    .sec{background:#fff;border-radius:14px;padding:24px;margin-bottom:12px}
    h2{font-size:15px;font-weight:700;color:#1A56DB;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #E2E8F0}
    p,li{font-size:14px;color:#475569;margin-bottom:6px}
    li{margin-left:20px}
    .footer{text-align:center;font-size:12px;color:#94A3B8;margin-top:20px;padding:16px}
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><span class="b">Geo</span><span class="g">Selfie</span></h1>
    <p style="color:#475569;margin-top:4px">Terms & Conditions · Last Updated: June 2026</p>
  </div>

  <div class="sec"><h2>1. Acceptance of Terms</h2>
    <p>By using GeoSelfie, you agree to these Terms and Conditions. If you do not agree, please do not use the app.</p>
  </div>

  <div class="sec"><h2>2. Use of Service</h2>
    <ul>
      <li>GeoSelfie is an educational attendance management platform.</li>
      <li>You must provide accurate personal information during registration.</li>
      <li>You must not attempt to fake your location or use mock GPS.</li>
      <li>Misuse of the platform may result in account suspension.</li>
    </ul>
  </div>

  <div class="sec"><h2>3. Teacher Responsibilities</h2>
    <ul>
      <li>Teachers are responsible for sharing class codes only with their students.</li>
      <li>Teachers must set up college location accurately for geofencing to work.</li>
      <li>Teachers must subscribe to unlock full features after the 30-day trial.</li>
    </ul>
  </div>

  <div class="sec"><h2>4. Subscription & Payments</h2>
    <ul>
      <li>Teacher accounts include a 30-day free trial upon registration.</li>
      <li>Subscription plans: 1 Month (₹299), 3 Months (₹799), 6 Months (₹1499), 1 Year (₹2499).</li>
      <li>All payments are processed securely via Razorpay.</li>
      <li>Subscriptions are non-refundable once activated.</li>
      <li>Students and parents get free access linked to their teacher's subscription.</li>
    </ul>
  </div>

  <div class="sec"><h2>5. Intellectual Property</h2>
    <p>GeoSelfie, its logo, code, and all content are the intellectual property of GeoSelfie — Geo Selfie Identity. © 2026. All rights reserved.</p>
  </div>

  <div class="sec"><h2>6. Limitation of Liability</h2>
    <p>GeoSelfie is not liable for attendance disputes, network failures, or GPS inaccuracies beyond our control.</p>
  </div>

  <div class="sec"><h2>7. Governing Law</h2>
    <p>These terms are governed by Indian law, including the DPDP Act 2023 and IT Act 2000.</p>
  </div>

  <div class="footer">
    <p>© 2026 GeoSelfie — Geo Selfie Identity · All rights reserved.</p>
    <p style="margin-top:4px">For queries: <a href="mailto:support@geoselfie.in" style="color:#1A56DB">support@geoselfie.in</a></p>
  </div>
</div>
</body></html>`);
});

// PUBLIC — JSON policy
router.get('/policy', (req, res) => {
  res.json({
    app:'GeoSelfie — Geo Selfie Identity', version:'3.0',
    last_updated:'2026-06-01',
    dpo_email:'dpo@geoselfie.in', grievance_email:'grievance@geoselfie.in',
    compliance:'DPDP Act 2023 (India)',
    data_collected:[
      { type:'Live Selfie', stored_permanently:false, retention:'60 seconds' },
      { type:'GPS Location', stored_permanently:false, retention:'60 seconds' },
      { type:'Attendance Record', stored_permanently:true, retention:'1 academic year' },
      { type:'Email & Name', stored_permanently:true, retention:'Until deletion' },
      { type:'Phone Number', stored_permanently:true, retention:'Until deletion' },
    ],
    copyright:'© 2026 GeoSelfie — All rights reserved.'
  });
});

// AUTHENTICATED routes
router.post('/consent', authMiddleware, (req, res) => {
  try {
    const { consent_type, given } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    dbRun('INSERT INTO consent_logs (id, user_id, consent_type, given, timestamp, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, consent_type, given?1:0, nowISO(), ip]);
    res.json({ message: 'Consent logged', timestamp: nowISO() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/my-data', authMiddleware, (req, res) => {
  try {
    const userId   = req.user.id;
    const user     = dbGet('SELECT id,name,email,phone,role,roll_no,class_code,created_at FROM users WHERE id = ?', [userId]);
    const attCount = dbAll('SELECT status, COUNT(*) as count FROM attendance_sessions WHERE student_id = ? GROUP BY status', [userId]);
    const consents = dbAll('SELECT consent_type,given,timestamp FROM consent_logs WHERE user_id = ? ORDER BY timestamp DESC', [userId]);
    res.json({
      data: {
        account: user, attendance: attCount, consent_history: consents,
        data_policy: { selfie_stored:false, location_stored:false, retention:'1 academic year' }
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/delete-my-data', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const user   = dbGet('SELECT email FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const reqId = uuidv4();
    dbRun('INSERT INTO data_deletion_requests (id, user_id, email, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)',
      [reqId, userId, user.email, req.body?.reason||'User requested', 'pending', nowISO()]);

    dbRun('DELETE FROM attendance_sessions WHERE student_id = ?', [userId]);
    dbRun('DELETE FROM verify_logs WHERE student_id = ?', [userId]);
    dbRun('DELETE FROM location_events WHERE student_id = ?', [userId]);
    dbRun('DELETE FROM consent_logs WHERE user_id = ?', [userId]);

    res.json({ message: 'Deletion request received. Account deleted within 30 days (DPDP Act 2023).', request_id: reqId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;