/*
 * © 2026 GeoSelfie v2.0 — All rights reserved.
 */
const { getDistance } = require('geolib');

function isInsideGeofence(lat, lng, collegeLat, collegeLng, radiusMeters = 200) {
  const distance = getDistance(
    { latitude: lat, longitude: lng },
    { latitude: collegeLat, longitude: collegeLng }
  );
  return { inside: distance <= radiusMeters, distance: Math.round(distance) };
}

function isCollegeTime(startTime, endTime, lunchStart, lunchEnd) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = t => { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h*60+m; };
  return {
    isOpen:  cur >= toMin(startTime) && cur <= toMin(endTime),
    isLunch: cur >= toMin(lunchStart) && cur <= toMin(lunchEnd),
    current: cur
  };
}

// Anti Fake GPS Detection
function detectFakeGPS(accuracy, speed, altitude) {
  const reasons = [];
  if (accuracy !== null && accuracy < 1) reasons.push('Suspiciously perfect accuracy');
  if (speed !== null && speed > 50)      reasons.push('Moving too fast');
  if (altitude === 0)                     reasons.push('Altitude exactly 0 (mock GPS)');
  return { isFake: reasons.length > 0, reasons };
}

module.exports = { isInsideGeofence, isCollegeTime, detectFakeGPS };