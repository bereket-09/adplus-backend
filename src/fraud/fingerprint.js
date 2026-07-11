/**
 * fingerprint.js — Deterministic, I/O-free derivations from a decoded meta
 * payload: a stable device fingerprint, a coarse user-agent class, and a geo
 * bucket. Used to build the `subject` every fraud signal reads.
 */
const crypto = require('crypto');
const cfg = require('../config/engine');

/** Stable 16-hex device fingerprint from device attributes. */
function deviceFp(device) {
  const d = device || {};
  const basis = [d.type, d.model, d.brand, d.platform].map((x) => String(x || '')).join('|').toLowerCase();
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** Classify a UA string as normal | bot | headless. */
function classifyUa(ua) {
  const s = String(ua || '').trim();
  if (!s || s.length < 8) return 'headless';
  if (/(bot|crawl|spider|headless|phantom|selenium|puppeteer|playwright|curl|wget|python-requests|okhttp|node-fetch|axios|go-http)/i.test(s)) return 'bot';
  return 'normal';
}

/** Round lat/lon to a grid bucket string, or null if absent. */
function geoBucket(location) {
  if (!location || location.lat == null || location.lon == null) return null;
  const dec = cfg.fraud.geo.gridDecimals;
  const lat = Number(location.lat).toFixed(dec);
  const lon = Number(location.lon).toFixed(dec);
  if (isNaN(Number(lat)) || isNaN(Number(lon))) return null;
  return `${lat},${lon}`;
}

/** True when lat/lon fall outside the configured (Ethiopia) bounding box. */
function outsideBbox(location) {
  if (!location || location.lat == null || location.lon == null) return false;
  const [minLat, minLon, maxLat, maxLon] = cfg.fraud.geo.bbox;
  const lat = Number(location.lat), lon = Number(location.lon);
  if (isNaN(lat) || isNaN(lon)) return false;
  return lat < minLat || lat > maxLat || lon < minLon || lon > maxLon;
}

/** Rough great-circle distance (km) between two "lat,lon" buckets. */
function bucketDistanceKm(a, b) {
  if (!a || !b) return 0;
  const [la1, lo1] = a.split(',').map(Number);
  const [la2, lo2] = b.split(',').map(Number);
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Build the fraud `subject` from a decoded meta payload (+ optional watch/token).
 */
function buildSubject(payload = {}, extra = {}) {
  return {
    msisdn: extra.msisdn || payload.msisdn || null,
    ip: payload.ip || extra.ip || null,
    deviceFp: payload.device ? deviceFp(payload.device) : (extra.deviceFp || null),
    ua: payload.userAgent || extra.ua || '',
    uaClass: classifyUa(payload.userAgent || extra.ua || ''),
    geoBucket: geoBucket(payload.location),
    location: payload.location || null,
    token: extra.token || null,
    watch: extra.watch || null,
    metaFlags: extra.metaFlags || [],
  };
}

module.exports = { deviceFp, classifyUa, geoBucket, outsideBbox, bucketDistanceKm, buildSubject };
