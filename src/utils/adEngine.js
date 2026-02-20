const Ad = require('../models/ad.model');
const cache = require('./internalCache');
const logger = require('./logger');

const ACTIVE_ADS_CACHE_KEY = 'adengine:active_ads';
const ACTIVE_ADS_CACHE_TTL = 15_000; // 15 seconds — fresh enough, but avoids hammering DB

// In-memory store: { msisdn: { queue: [adId1, adId2, ...], lastServed: Date } }
const userAdMemory = {};

// Cleanup old user memory entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 min
  for (const [msisdn, data] of Object.entries(userAdMemory)) {
    if (data.lastServed && data.lastServed.getTime() < cutoff) {
      delete userAdMemory[msisdn];
    }
  }
}, 10 * 60 * 1000);

/**
 * Get active ads with in-memory caching
 */
async function getActiveAds() {
  const cached = cache.get(ACTIVE_ADS_CACHE_KEY);
  if (cached) return cached;

  const now = new Date();
  const activeAds = await Ad.find({
    status: 'active',
    remaining_budget: { $gt: 0 },
  }).sort({ priority: -1, created_at: 1 }).lean();

  cache.set(ACTIVE_ADS_CACHE_KEY, activeAds, ACTIVE_ADS_CACHE_TTL);
  return activeAds;
}

/**
 * Priority-weighted shuffle:
 * Ads with higher priority appear more often in the rotation.
 * Priority 10 = 10x weight, Priority 1 = 1x weight.
 */
function weightedShuffle(ads) {
  const premiumAds = ads.filter(a => a.rate_tier === 'premium');
  const normalAds = ads.filter(a => a.rate_tier !== 'premium');

  // Traffic allocation: 70% to Premium, 30% to Normal (if both pools exist)
  const premiumRatio = (premiumAds.length > 0 && normalAds.length > 0) ? 0.7 : (premiumAds.length > 0 ? 1.0 : 0.0);

  const weighted = [];
  // Generate a large pool to ensure distribution
  for (let i = 0; i < 200; i++) {
    const usePremium = Math.random() < premiumRatio;
    const pool = usePremium ? premiumAds : normalAds;

    if (pool.length > 0) {
      // Pick within pool based on priority
      const poolWeighted = [];
      for (const ad of pool) {
        const weight = Math.max(1, ad.priority || 5);
        for (let w = 0; w < weight; w++) poolWeighted.push(ad._id.toString());
      }
      const pickedId = poolWeighted[Math.floor(Math.random() * poolWeighted.length)];
      weighted.push(pickedId);
    }
  }

  // Deduplicate while preserving weighted order
  const seen = new Set();
  const result = [];
  for (const id of weighted) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  // If we still have ads not in the result (due to probability), append them
  for (const ad of ads) {
    const id = ad._id.toString();
    if (!seen.has(id)) {
      result.push(id);
    }
  }

  return result;
}

/**
 * Select the best ad for a given MSISDN.
 * Uses priority-weighted rotation, cached active ads, and per-user queues.
 *
 * @param {string} msisdn - subscriber identifier
 * @param {object} options - optional filters
 * @param {string[]} options.tags - filter by tags (e.g. ['sports'])
 * @param {string} options.deviceType - filter by device compatibility
 */
exports.selectAd = async (msisdn, options = {}) => {
  let activeAds = await getActiveAds();

  if (!activeAds.length) return null;

  // Optional tag filtering
  if (options.tags && options.tags.length > 0) {
    const tagFiltered = activeAds.filter(ad =>
      ad.tags && ad.tags.some(t => options.tags.includes(t))
    );
    // Fall back to all ads if no tag match
    if (tagFiltered.length > 0) activeAds = tagFiltered;
  }

  // Initialize or refresh user queue
  if (!userAdMemory[msisdn] || userAdMemory[msisdn].queue.length === 0) {
    userAdMemory[msisdn] = {
      queue: weightedShuffle(activeAds),
      lastServed: new Date()
    };
  }

  // Pop the next ad from queue
  const nextAdId = userAdMemory[msisdn].queue.shift();
  userAdMemory[msisdn].lastServed = new Date();

  const nextAd = activeAds.find(ad => ad._id.toString() === nextAdId);

  // If ad somehow disappeared from active set, try next
  if (!nextAd && userAdMemory[msisdn].queue.length > 0) {
    return exports.selectAd(msisdn, options);
  }

  return nextAd || activeAds[0]; // Absolute fallback
};

/**
 * Invalidate the active ads cache (call after ad create/update/approve)
 */
exports.invalidateCache = () => {
  cache.del(ACTIVE_ADS_CACHE_KEY);
};

/**
 * Get recommendation stats (for admin dashboard)
 */
exports.getStats = () => {
  return {
    cached_ads: cache.get(ACTIVE_ADS_CACHE_KEY)?.length || 0,
    active_user_queues: Object.keys(userAdMemory).length,
    cache_ttl_ms: ACTIVE_ADS_CACHE_TTL
  };
};
