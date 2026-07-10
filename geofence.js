/*
 * © 2026 GeoSelfie — All rights reserved.
 * FIX: Accurate geofence, anti-fake GPS
 */

// Haversine formula — accurate distance in meters
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 6371000 // Earth radius meters
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLon/2) * Math.sin(dLon/2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function isInsideGeofence(lat, lng, centerLat, centerLng, radiusMeters = 200) {
  if (!centerLat || !centerLng || !lat || !lng)
    return { inside: false, distance: null }

  const dist = haversineDistance(
    parseFloat(lat), parseFloat(lng),
    parseFloat(centerLat), parseFloat(centerLng)
  )
  return {
    inside:   dist <= radiusMeters,
    distance: Math.round(dist),
  }
}

// IST-aware college time check
function isCollegeTime(startTime, endTime, lunchStart, lunchEnd) {
  const now = new Date()
  // IST offset
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  const h   = ist.getUTCHours()
  const m   = ist.getUTCMinutes()
  const cur = h * 60 + m

  const toMin = (t) => {
    if (!t) return 0
    const [hh, mm] = t.split(':').map(Number)
    return hh * 60 + mm
  }

  const start  = toMin(startTime  || '08:00')
  const end    = toMin(endTime    || '18:00')
  const lStart = toMin(lunchStart || '13:00')
  const lEnd   = toMin(lunchEnd   || '14:00')

  const isOpen  = cur >= start && cur <= end
  const isLunch = cur >= lStart && cur <= lEnd

  return { isOpen, isLunch, currentMinutes: cur }
}

// FIX: Improved fake GPS detection
function detectFakeGPS(accuracy, speed, altitude) {
  const reasons = []

  // Mock GPS apps usually give perfect accuracy
  if (accuracy !== null && accuracy !== undefined && accuracy === 0) {
    reasons.push('Perfect zero accuracy — likely mock')
  }

  // Unrealistically high speed (>100 km/h = 27.8 m/s)
  if (speed !== null && speed !== undefined && speed > 28) {
    reasons.push(`Unrealistic speed: ${speed} m/s`)
  }

  // Suspiciously perfect altitude
  if (altitude !== null && altitude !== undefined && altitude === 0 && accuracy === 0) {
    reasons.push('Perfect zero values — likely mock GPS')
  }

  // Very low accuracy (GPS jammer or indoor)
  // Note: We don't flag high accuracy numbers as fake

  return {
    isFake:  reasons.length >= 2, // Need 2+ signals to flag
    reasons,
  }
}

module.exports = { isInsideGeofence, isCollegeTime, detectFakeGPS }