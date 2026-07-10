/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Concurrent safety, role checks
 */
const jwt = require('jsonwebtoken')

function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' })

    const token = header.split(' ')[1]
    if (!token)
      return res.status(401).json({ error: 'Invalid token format' })

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user      = decoded
    next()
  } catch(e) {
    if (e.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expired — please login again' })
    if (e.name === 'JsonWebTokenError')
      return res.status(401).json({ error: 'Invalid token — please login again' })
    return res.status(401).json({ error: 'Authentication failed' })
  }
}

function teacherOnly(req, res, next) {
  if (req.user?.role !== 'teacher')
    return res.status(403).json({ error: 'Teacher access required' })
  next()
}

function studentOnly(req, res, next) {
  if (req.user?.role !== 'student')
    return res.status(403).json({ error: 'Student access required' })
  next()
}

function parentOnly(req, res, next) {
  if (req.user?.role !== 'parent')
    return res.status(403).json({ error: 'Parent access required' })
  next()
}

module.exports = { authMiddleware, teacherOnly, studentOnly, parentOnly }