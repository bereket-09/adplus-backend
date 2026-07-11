/**
 * reputation.js — Per-entity bad-reputation score with exponential time-decay.
 * Repeat offenders accumulate; idle entities decay back toward zero, so a single
 * bad day doesn't pin a subscriber forever. Pure Redis via store.js.
 */
const store = require('../lib/store');
const cfg = require('../config/engine');
const k = require('./keys');
const logger = require('../utils/logger');

function decay(score, lastTsMs, nowMs) {
  if (!score || !lastTsMs) return score || 0;
  const dt = Math.max(0, (nowMs - lastTsMs) / 1000);
  const factor = Math.pow(0.5, dt / cfg.fraud.reputation.halfLifeSec);
  return score * factor;
}

/** Current decayed reputation score for an entity. */
async function decayedScore(type, id) {
  if (!id) return 0;
  try {
    const [raw, ts] = await Promise.all([
      store.getInt(k.repScore(type, id)),
      store.getString(k.repTs(type, id)),
    ]);
    return decay(Number(raw) || 0, ts ? Number(ts) : 0, Date.now());
  } catch (e) {
    logger.warn(`reputation.decayedScore - ${e.message}`);
    return 0;
  }
}

/** Add `delta` (can be negative) to an entity's reputation, decay-adjusted. */
async function bump(type, id, delta) {
  if (!id || !delta) return;
  try {
    const cur = await decayedScore(type, id);
    const next = Math.max(0, cur + delta);
    await Promise.all([
      store.setCounter(k.repScore(type, id), Math.round(next)),
      store.setString(k.repTs(type, id), String(Date.now())),
      store.setAdd(k.repIndex(type), String(id), cfg.fraud.reputation.halfLifeSec * 2),
    ]);
  } catch (e) {
    logger.warn(`reputation.bump - ${e.message}`);
  }
}

module.exports = { decayedScore, bump };
