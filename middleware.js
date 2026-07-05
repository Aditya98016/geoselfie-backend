/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Please login first' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(403).json({ error: 'Session expired, please login again' }); }
}

function teacherOnly(req, res, next) {
  if (req.user?.role !== 'teacher')
    return res.status(403).json({ error: 'Only teachers can access this' });
  next();
}

function parentOnly(req, res, next) {
  if (req.user?.role !== 'parent')
    return res.status(403).json({ error: 'Only parents can access this' });
  next();
}

function studentOnly(req, res, next) {
  if (req.user?.role !== 'student')
    return res.status(403).json({ error: 'Only students can access this' });
  next();
}

module.exports = { authMiddleware, teacherOnly, parentOnly, studentOnly };