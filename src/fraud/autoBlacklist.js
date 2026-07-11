/**
 * autoBlacklist.js — Escalating auto-blacklist ladder. Repeat offenders climb
 * warn → block(6h) → block(24h) → block(72h) → permanent. A single false positive
 * expires quickly via the Blacklist TTL index; persistent abuse gets pinned.
 * Fire-and-forget from the hot path.
 */
const Blacklist = require('../models/blacklist.model');
const blacklistCheck = require('../utils/blacklistCheck');
const store = require('../lib/store');
const cfg = require('../config/engine');
const k = require('./keys');
const logger = require('../utils/logger');

function severityForOffense(offense) {
  const ab = cfg.fraud.autoBlacklist;
  if (offense >= ab.permanentAtOffense) return { severity: 'permanent', expires_at: null };
  if (offense <= 1) return { severity: 'warn', expires_at: new Date(Date.now() + ab.warnTtlSec * 1000) };
  // offense 2,3,4 → escalateHours[0..]
  const hoursIdx = Math.min(offense - 2, ab.escalateHours.length - 1);
  const hours = ab.escalateHours[hoursIdx] || 6;
  return { severity: 'block', expires_at: new Date(Date.now() + hours * 3600 * 1000) };
}

/**
 * Escalate an entity (type ∈ msisdn|ip|device) onto the blacklist.
 * @returns {Promise<{offense:number, severity:string}|null>}
 */
async function escalate(type, value, reason = 'auto_detected') {
  if (!type || !value) return null;
  try {
    const offense = await store.incrWithTtl(k.offense(type, value), cfg.fraud.autoBlacklist.offenseWindowDays * 86400);
    const { severity, expires_at } = severityForOffense(offense);

    await Blacklist.updateOne(
      { type, value },
      {
        $set: { severity, expires_at, reason, blocked_by: 'fraud-engine', is_active: true, updated_at: new Date() },
        $inc: { hit_count: 1 },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true }
    );
    blacklistCheck.invalidateCache();
    logger.warn(`autoBlacklist - ${type}=${value} offense#${offense} -> ${severity}`);
    return { offense, severity };
  } catch (e) {
    logger.error(`autoBlacklist.escalate - ${e.message}`);
    return null;
  }
}

module.exports = { escalate, severityForOffense };
