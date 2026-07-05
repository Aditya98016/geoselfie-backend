/*
 * © 2026 GeoSelfie — All rights reserved.
 * Subscription & Access Control
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('./database');
const { authMiddleware, teacherOnly } = require('./middleware');

const router = express.Router();
const nowISO = () => new Date().toISOString();

// Plans config
const PLANS = {
  trial:    { label:'Free Trial',  days:30,  price:0,    currency:'INR' },
  monthly:  { label:'1 Month',     days:30,  price:299,  currency:'INR' },
  quarterly:{ label:'3 Months',    days:90,  price:799,  currency:'INR' },
  biannual: { label:'6 Months',    days:180, price:1499, currency:'INR' },
  annual:   { label:'1 Year',      days:365, price:2499, currency:'INR' },
};

// Auto-create trial subscription when teacher registers
function createTrialSubscription(teacherId) {
  const existing = dbGet('SELECT id FROM subscriptions WHERE teacher_id = ?', [teacherId]);
  if (existing) return existing;
  const id      = uuidv4();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  dbRun(`INSERT INTO subscriptions (id, teacher_id, plan, status, started_at, expires_at, trial_used, amount, created_at)
         VALUES (?, ?, 'trial', 'active', ?, ?, 1, 0, ?)`,
    [id, teacherId, nowISO(), expires, nowISO()]);
  return { id, plan:'trial', status:'active', expires_at: expires };
}

// Check if teacher subscription is active
function isSubscriptionActive(teacherId) {
  const sub = dbGet('SELECT * FROM subscriptions WHERE teacher_id = ?', [teacherId]);
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  if (sub.expires_at && new Date() > new Date(sub.expires_at)) {
    dbRun('UPDATE subscriptions SET status = ? WHERE teacher_id = ?', ['expired', teacherId]);
    return false;
  }
  return true;
}

// GET /api/subscription/status — Check current user's subscription
router.get('/status', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const role   = req.user.role;

  if (role === 'teacher') {
    let sub = dbGet('SELECT * FROM subscriptions WHERE teacher_id = ?', [userId]);
    if (!sub) sub = createTrialSubscription(userId);

    // Check expiry
    const active = isSubscriptionActive(userId);
    const daysLeft = sub.expires_at
      ? Math.max(0, Math.ceil((new Date(sub.expires_at) - Date.now()) / (1000*60*60*24)))
      : 0;

    return res.json({
      role: 'teacher',
      subscription: { ...sub, is_active: active, days_left: daysLeft },
      plans: PLANS,
      features: active ? getAllFeatures() : getTrialFeatures(),
    });
  }

  // Student or Parent — check teacher's subscription
  const classCode = req.user.class_code;
  const teacher   = classCode
    ? dbGet('SELECT id FROM users WHERE class_code = ? AND role = ?', [classCode, 'teacher'])
    : null;
  const teacherSub = teacher ? dbGet('SELECT * FROM subscriptions WHERE teacher_id = ?', [teacher.id]) : null;
  const teacherActive = teacher ? isSubscriptionActive(teacher.id) : false;

  res.json({
    role,
    teacher_subscription_active: teacherActive,
    subscription: teacherSub || null,
    features: teacherActive ? getAllFeatures() : getLimitedFeatures(),
  });
});

// GET /api/subscription/plans — All plans
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// POST /api/subscription/activate — Activate/upgrade plan
router.post('/activate', authMiddleware, teacherOnly, async (req, res) => {
  const { plan, payment_id } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const planConfig = PLANS[plan];
  const expires    = new Date(Date.now() + planConfig.days * 24 * 60 * 60 * 1000).toISOString();
  const teacherId  = req.user.id;

  const existing = dbGet('SELECT id FROM subscriptions WHERE teacher_id = ?', [teacherId]);
  if (existing) {
    dbRun(`UPDATE subscriptions SET plan=?, status='active', started_at=?, expires_at=?, payment_id=?, amount=? WHERE teacher_id=?`,
      [plan, nowISO(), expires, payment_id||null, planConfig.price, teacherId]);
  } else {
    dbRun(`INSERT INTO subscriptions (id, teacher_id, plan, status, started_at, expires_at, trial_used, payment_id, amount, created_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), teacherId, plan, nowISO(), expires, plan==='trial'?1:0, payment_id||null, planConfig.price, nowISO()]);
  }

  res.json({ message: `Plan activated: ${planConfig.label}`, expires_at: expires, plan });
});

// POST /api/subscription/cancel
router.post('/cancel', authMiddleware, teacherOnly, (req, res) => {
  dbRun('UPDATE subscriptions SET status = ? WHERE teacher_id = ?', ['cancelled', req.user.id]);
  res.json({ message: 'Subscription cancelled' });
});

// GET /api/subscription/check-access — Check if a feature is accessible
router.get('/check-access', authMiddleware, (req, res) => {
  const { feature } = req.query;
  const role        = req.user.role;

  if (role === 'teacher') {
    const active = isSubscriptionActive(req.user.id);
    const sub    = dbGet('SELECT plan FROM subscriptions WHERE teacher_id = ?', [req.user.id]);
    if (!active) return res.json({ access: false, reason: 'Subscription expired', upgrade_required: true });

    // Trial limitations
    if (sub?.plan === 'trial' && PREMIUM_ONLY_FEATURES.includes(feature)) {
      const sub2 = dbGet('SELECT * FROM subscriptions WHERE teacher_id = ?', [req.user.id]);
      const days = Math.ceil((new Date(sub2.expires_at)-Date.now())/(1000*60*60*24));
      return res.json({ access: true, trial: true, days_left: days });
    }
    return res.json({ access: true });
  }

  // Student/Parent
  const classCode    = req.user.class_code;
  const teacher      = dbGet('SELECT id FROM users WHERE class_code = ? AND role = ?', [classCode, 'teacher']);
  const teacherActive = teacher ? isSubscriptionActive(teacher.id) : false;
  res.json({ access: teacherActive, teacher_subscription_required: !teacherActive });
});

const PREMIUM_ONLY_FEATURES = ['ai_insights', 'bulk_export', 'advanced_reports', 'face_recognition'];

function getAllFeatures() {
  return {
    attendance:        true,
    geo_verify:        true,
    qr_attendance:     true,
    period_wise:       true,
    geochat:           true,
    academics:         true,
    leave_management:  true,
    notice_board:      true,
    ai_insights:       true,
    advanced_reports:  true,
    bulk_export:       true,
    parent_connect:    true,
    push_notifications:true,
    multi_language:    true,
    face_recognition:  false, // future
  };
}
function getTrialFeatures() { return { ...getAllFeatures(), bulk_export: true, ai_insights: true }; }
function getLimitedFeatures() {
  return {
    attendance:        true,
    geo_verify:        true,
    geochat:           false,
    academics:         true,
    ai_insights:       false,
    advanced_reports:  false,
    bulk_export:       false,
  };
}

module.exports = { router, createTrialSubscription, isSubscriptionActive };