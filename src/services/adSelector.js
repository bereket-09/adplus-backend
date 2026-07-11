/**
 * adSelector.js — Chooses which ads a subscriber is *allowed* to see, in a sane
 * order, without repeats.
 *
 * Responsibilities:
 *   - Load the currently-servable ad set (active + in-schedule), briefly cached.
 *   - Exclude everything already in the subscriber's seen-set (no duplicates).
 *   - Rank the remaining unseen ads by priority / tier so the engine can walk the
 *     list and take the first one that also passes pacing + budget.
 *
 * It deliberately does NOT reserve budget or consume pacing tokens — that is the
 * decision engine's job, so selection stays a pure, testable ranking step.
 */

const Ad = require('../models/ad.model');
const cache = require('../utils/internalCache');

const ACTIVE_KEY = 'selector:active_ads';
const ACTIVE_TTL = 10_000; // 10s — fresh enough for pacing, cheap on Mongo

/** Active, in-schedule ads. Cached briefly to avoid hammering Mongo on spikes. */
async function getServableAds() {
  const cached = cache.get(ACTIVE_KEY);
  if (cached) return cached;

  const now = new Date();
  const ads = await Ad.find({
    status: 'active',
    remaining_budget: { $gt: 0 },
    $and: [
      { $or: [{ start_date: { $exists: false } }, { start_date: null }, { start_date: { $lte: now } }] },
      { $or: [{ end_date: { $exists: false } }, { end_date: null }, { end_date: { $gte: now } }] },
    ],
  }).sort({ priority: -1, created_at: 1 }).lean();

  cache.set(ACTIVE_KEY, ads, ACTIVE_TTL);
  return ads;
}

function invalidate() { cache.del(ACTIVE_KEY); }

/** Priority-weighted ranking of unseen ads (premium tier gets extra weight). */
function rankUnseen(ads, seenSet, ctx = {}) {
  let pool = ads.filter((a) => !seenSet.has(String(a._id)));

  // Optional tag targeting — fall back to full pool if nothing matches.
  if (ctx.tags && ctx.tags.length) {
    const tagged = pool.filter((a) => a.tags && a.tags.some((t) => ctx.tags.includes(t)));
    if (tagged.length) pool = tagged;
  }

  // Weighted shuffle: expand by weight, sample without replacement.
  const weightOf = (a) => Math.max(1, (a.priority || 5)) * (a.rate_tier === 'premium' ? 2 : 1);
  const bag = [];
  for (const a of pool) {
    const w = weightOf(a);
    for (let i = 0; i < w; i++) bag.push(a);
  }
  const ranked = [];
  const used = new Set();
  while (bag.length && ranked.length < pool.length) {
    const idx = Math.floor(Math.random() * bag.length);
    const a = bag[idx];
    bag.splice(idx, 1);
    const id = String(a._id);
    if (!used.has(id)) { used.add(id); ranked.push(a); }
  }
  return ranked;
}

/**
 * @returns {Promise<{ranked:Array, unseenCount:number, activeCount:number}>}
 */
async function selectForUser(msisdn, state, ctx = {}) {
  const ads = await getServableAds();
  const ranked = rankUnseen(ads, state.seen, ctx);
  return { ranked, unseenCount: ranked.length, activeCount: ads.length };
}

module.exports = { getServableAds, selectForUser, rankUnseen, invalidate };
