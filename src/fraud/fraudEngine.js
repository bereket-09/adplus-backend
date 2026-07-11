/**
 * fraudEngine.js — Public entry point. `evaluate(stage, subject, opts)` runs the
 * stage's signals, composes a risk score, maps it to an action, and applies
 * side-effects (reputation bump, durable detection record, auto-blacklist).
 *
 * Design invariant: hot path is Redis-O(1) and FAIL-OPEN — any internal error
 * returns `allow` so a Redis hiccup can never break the user flow.
 */
const cfg = require('../config/engine');
const logger = require('../utils/logger');
const { ALL, STAGE_SIGNALS } = require('./signals');
const policy = require('./policy');
const reputation = require('./reputation');
const autoBlacklist = require('./autoBlacklist');
const store = require('../lib/store');
const k = require('./keys');

let FraudDetection;
function detectionModel() {
  if (!FraudDetection) FraudDetection = require('../models/fraudDetection.model');
  return FraudDetection;
}

const ALLOW = { decision: 'allow', action: 'allow', score: 0, reasons: [], signals: [], waitMs: 0 };

/** Which dimension to blacklist when a hard signal trips. */
function escalationTarget(subject, hitIds) {
  const has = (frag) => hitIds.some((id) => id.includes(frag));
  if (subject.deviceFp && (has('device') || has('dev') || has('bot'))) return { type: 'device', value: subject.deviceFp };
  if (subject.ip && has('ip')) return { type: 'ip', value: subject.ip };
  if (subject.msisdn) return { type: 'msisdn', value: subject.msisdn };
  if (subject.ip) return { type: 'ip', value: subject.ip };
  if (subject.deviceFp) return { type: 'device', value: subject.deviceFp };
  return null;
}

async function evaluate(stage, subject, opts = {}) {
  if (!cfg.fraud.enabled) return ALLOW;
  try {
    const ids = STAGE_SIGNALS[stage] || [];
    if (!ids.length) return ALLOW;

    // Preload decayed reputation for the entities in play.
    const [repM, repI, repD] = await Promise.all([
      reputation.decayedScore('msisdn', subject.msisdn),
      reputation.decayedScore('ip', subject.ip),
      reputation.decayedScore('device', subject.deviceFp),
    ]);
    const ctx = { stage, repScores: { msisdn: repM, ip: repI, device: repD }, durationSeconds: opts.durationSeconds || 0 };

    const results = await Promise.all(
      ids.map((id) => Promise.resolve()
        .then(() => ALL[id](subject, ctx))
        .catch((e) => { logger.warn(`fraud.signal ${id} - ${e.message}`); return { id, hit: false, weight: 0 }; }))
    );

    const hits = results.filter((r) => r && r.hit);
    const hitIds = hits.map((h) => h.id);
    const raw = hits.reduce((a, h) => a + (h.weight || 0), 0);
    const newSubHit = results.some((r) => r.id === 'new_subscriber' && r.hit);
    const newSubMult = newSubHit ? cfg.fraud.newSub.multiplier : 1;
    const repMax = Math.max(repM, repI, repD);
    const repBonus = Math.min(20, repMax * 0.2);
    const hard = hits.some((h) => h.hard);
    const score = hard ? 100 : Math.min(100, raw * newSubMult + repBonus);
    const action = hard ? 'hard_block' : policy.scoreToAction(score);
    const decision = policy.isDenied(action, stage) ? 'deny' : 'allow';

    // ---- side effects (all fire-and-forget; never block the response) ----
    if (action !== 'allow') {
      const delta = (action === 'hard_block' || action === 'challenge')
        ? cfg.fraud.reputation.bumpHard : cfg.fraud.reputation.bumpSoft;
      if (subject.msisdn) reputation.bump('msisdn', subject.msisdn, delta);
      if (subject.ip) reputation.bump('ip', subject.ip, delta);
      if (subject.deviceFp) reputation.bump('device', subject.deviceFp, delta);

      detectionModel().create({
        stage,
        subject: { msisdn: subject.msisdn, ip: subject.ip, deviceFp: subject.deviceFp, token: subject.token },
        score, action, reasons: hitIds,
        signals: hits.map((h) => ({ id: h.id, value: h.value, weight: h.weight })),
        source: 'realtime',
        created_at: new Date(),
      }).catch((e) => logger.warn(`fraud.detection persist - ${e.message}`));

      if (action === 'hard_block') {
        const target = escalationTarget(subject, hitIds);
        if (target) autoBlacklist.escalate(target.type, target.value, 'fraud_' + (hitIds[0] || 'signal'));
      }
    }

    return { decision, action, score: Math.round(score), reasons: hitIds, signals: hits.map((h) => ({ id: h.id, value: h.value })), waitMs: action === 'throttle' ? 1500 : 0 };
  } catch (e) {
    logger.error(`fraudEngine.evaluate(${stage}) - ${e.message}`);
    return cfg.fraud.failOpen ? ALLOW : { decision: 'deny', action: 'hard_block', score: 100, reasons: ['engine_error'], signals: [], waitMs: 0 };
  }
}

/** Record a legitimately-completed reward view into the reward-farming counters. */
async function recordAllowedCompletion(subject) {
  try {
    if (subject.deviceFp) await store.incrWithTtl(k.rewardDev(subject.deviceFp), 86400);
    if (subject.ip) await store.incrWithTtl(k.rewardIpHour(subject.ip), 3600);
  } catch (e) { logger.warn(`fraud.recordAllowedCompletion - ${e.message}`); }
}

module.exports = { evaluate, recordAllowedCompletion };
