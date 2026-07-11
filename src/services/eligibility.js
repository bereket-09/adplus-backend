/**
 * eligibility.js — Transparent, tunable scoring that decides whether it is worth
 * spending an SMS on a subscriber *right now*. Not a black box: every factor is
 * explainable and every weight lives in config/engine.js.
 *
 * Score is in [0,1]. Below `eligibility.minScore` the subscriber is suppressed
 * with the dominant reason, so we save SMS cost and budget for users who will
 * actually engage — this is the "he's already seen everything / he keeps fishing
 * for rewards" guard.
 */

const cfg = require('../config/engine');

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * @param {object} state  from frequency.getState()
 * @param {object} ctx    { unseenCount, activeCount }
 * @returns {{score:number, factors:object, dominantWeak:string}}
 */
function computeScore(state, ctx) {
  const f = cfg.frequency;
  const w = cfg.eligibility.weights;

  // 1) Fresh inventory available for this user.
  const unseenAvailability = ctx.unseenCount > 0
    ? clamp01(ctx.unseenCount / Math.max(1, ctx.activeCount))
    : 0;

  // 2) Headroom under the tightest cap.
  const headrooms = [
    (f.maxSmsPerDay - state.smsDay) / f.maxSmsPerDay,
    (f.maxSmsPerWeek - state.smsWeek) / f.maxSmsPerWeek,
    (f.maxViewsPerDay - state.viewsDay) / f.maxViewsPerDay,
  ];
  const frequencyHeadroom = clamp01(Math.min(...headrooms));

  // 3) Recency — how far past the minimum gap we are (1 = well-rested user).
  let recency = 1;
  if (state.lastSmsMs) {
    const gapMs = Date.now() - state.lastSmsMs;
    recency = clamp01(gapMs / (f.minGapMinutes * 60_000));
  }

  // 4) Engagement — completion rate, but neutral until we have evidence.
  let engagement;
  if (state.sent < cfg.eligibility.engagementMinSamples) {
    engagement = 0.7; // benefit of the doubt for new subscribers
  } else {
    engagement = clamp01(state.done / Math.max(1, state.sent));
  }

  const factors = { unseenAvailability, frequencyHeadroom, recency, engagement };
  const score =
    w.unseenAvailability * unseenAvailability +
    w.frequencyHeadroom * frequencyHeadroom +
    w.recency * recency +
    w.engagement * engagement;

  // Report which factor dragged the score down (for audit/observability).
  const weakest = Object.entries(factors).sort((a, b) => a[1] - b[1])[0];
  return { score: clamp01(score), factors, dominantWeak: weakest ? weakest[0] : null };
}

module.exports = { computeScore };
