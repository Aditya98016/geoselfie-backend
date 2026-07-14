/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX 3: Real Gmail SMTP — App Password se kaam karega
 */
const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass ||
      user === 'your_gmail@gmail.com' ||
      pass === 'your_gmail_app_password') {
    return null;
  }

  _transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth:   { user, pass },
    tls:    { rejectUnauthorized: false },
  });

  // Connection test
  _transporter.verify((err) => {
    if (err) {
      console.error('❌ Email config error:', err.message);
      console.log('💡 Check EMAIL_USER and EMAIL_PASS in .env');
      _transporter = null;
    } else {
      console.log('✅ Email server connected — real OTPs will be sent');
    }
  });

  return _transporter;
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendMail(to, subject, html) {
  const t = getTransporter();

  // Always log to console (backup)
  console.log(`\n📧 Email to: ${to}\n   Subject: ${subject}\n`);

  if (!t) {
    console.warn('⚠️  Email not configured — check .env EMAIL_USER and EMAIL_PASS');
    return false;
  }

  try {
    const info = await t.sendMail({
      from: `"GeoSelfie" <${process.env.EMAIL_USER}>`,
      to, subject, html
    });
    console.log(`✅ Email sent: ${info.messageId}`);
    return true;
  } catch(e) {
    console.error('❌ Email send failed:', e.message);
    return false;
  }
}

async function sendOTPEmail(email, otp, name = 'User') {
  // Always print to console for dev fallback
  console.log(`\n🔑 OTP for ${email}: [ ${otp} ] (10 min valid)\n`);

  return sendMail(email, 'GeoSelfie — Email Verification OTP', `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#F1F5F9;border-radius:16px;">
      <div style="text-align:center;margin-bottom:24px;">
        <h1 style="font-size:28px;font-weight:800;margin:0;">
          <span style="color:#1A56DB">Geo</span><span style="color:#059669">Selfie</span>
        </h1>
        <p style="color:#475569;font-size:13px;margin-top:4px;">Smart Presence, Verified</p>
      </div>
      <div style="background:#fff;border-radius:14px;padding:28px;text-align:center;">
        <p style="font-size:16px;color:#0F172A;margin:0 0 8px;">Hello <b>${name}</b>,</p>
        <p style="color:#475569;font-size:14px;margin:0 0 20px;">Your email verification OTP is:</p>
        <div style="background:#EBF2FF;border:2px solid rgba(26,86,219,0.2);border-radius:12px;padding:24px;margin:0 0 20px;">
          <span style="font-size:44px;font-weight:800;color:#1A56DB;letter-spacing:10px;">${otp}</span>
        </div>
        <p style="color:#94A3B8;font-size:12px;margin:0;">Valid for 10 minutes. Do not share with anyone.</p>
      </div>
      <p style="text-align:center;font-size:11px;color:#94A3B8;margin-top:20px;">
        © 2026 GeoSelfie — Geo Selfie Identity · All rights reserved.
      </p>
    </div>
  `);
}

async function sendVerifyAlert(email, name, periodName) {
  return sendMail(email, `📸 GeoSelfie — Verify Attendance: ${periodName}`, `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#F1F5F9;border-radius:16px;">
      <h1 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 20px;">
        <span style="color:#1A56DB">Geo</span><span style="color:#059669">Selfie</span>
      </h1>
      <div style="background:#EBF2FF;border:1px solid rgba(26,86,219,.2);border-radius:14px;padding:24px;text-align:center;">
        <p style="font-size:36px;margin:0 0 12px;">📸</p>
        <h2 style="color:#1A56DB;margin:0 0 8px;">Attendance Verification</h2>
        <p style="color:#475569;margin:0;">Hello <b>${name}</b>, please open GeoSelfie app and verify your attendance for <b>${periodName}</b>.</p>
      </div>
      <p style="text-align:center;font-size:11px;color:#94A3B8;margin-top:16px;">© 2026 GeoSelfie — All rights reserved.</p>
    </div>
  `);
}

async function sendParentAlert(parentEmail, parentName, studentName, date, status) {
  return sendMail(parentEmail, `GeoSelfie — ${studentName}'s Attendance Update`, `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#F1F5F9;border-radius:16px;">
      <h1 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 16px;">
        <span style="color:#1A56DB">Geo</span><span style="color:#059669">Selfie</span>
      </h1>
      <div style="background:#fff;border-radius:14px;padding:20px;">
        <p>Dear <b>${parentName}</b>,</p>
        <p>Your child <b>${studentName}</b>'s attendance for <b>${date}</b>:</p>
        <div style="background:${status==='present'?'#ECFDF5':'#FEF2F2'};border-radius:10px;padding:16px;text-align:center;margin:16px 0;">
          <span style="font-size:22px;font-weight:800;color:${status==='present'?'#059669':'#DC2626'}">${status.toUpperCase()}</span>
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#94A3B8;margin-top:16px;">© 2026 GeoSelfie — All rights reserved.</p>
    </div>
  `);
}

async function sendSupportTicketEmail(email, ticketNumber, subject) {
  return sendMail(email, `GeoSelfie Support — Ticket #${ticketNumber}`, `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#F1F5F9;border-radius:16px;">
      <h1 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 16px;">
        <span style="color:#1A56DB">Geo</span><span style="color:#059669">Selfie</span>
      </h1>
      <div style="background:#fff;border-radius:14px;padding:20px;">
        <h3 style="color:#1A56DB;margin:0 0 12px;">Support Ticket Received</h3>
        <p>Ticket: <b style="font-family:monospace">#${ticketNumber}</b></p>
        <p>Subject: ${subject}</p>
        <p style="color:#475569;">We will respond within 24 hours.</p>
      </div>
      <p style="text-align:center;font-size:11px;color:#94A3B8;margin-top:16px;">© 2026 GeoSelfie — All rights reserved.</p>
    </div>
  `);
}

module.exports = {
  generateOTP, sendOTPEmail, sendVerifyAlert,
  sendParentAlert, sendSupportTicketEmail
};