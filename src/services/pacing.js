/**
 * pacing.js — Spends a campaign's daily budget smoothly instead of in a morning
 * spike, and protects the SMS gateway with a global rate ceiling.
 *
 * Two token buckets:
 *   - GLOBAL gateway bucket: hard cap on SMS/sec across the whole platform. The
 *     worker acquires one token per dispatch; this is what keeps the HTTP SMS
 *     gateway from being overrun regardless of how much budget exists.
 *   - PER-CAMPAIGN bucket: refills at (affordable views / spend-window seconds),
 *     so each campaign trickles its budget across the window. A campaign that is
 *     momentarily ahead of pace yields to others until it refills.
 *
 * The queue is what buffers the morning stampede; pacing is what sets the drain
 * rate. Together they turn "1M triggers in 20 min, budget for 100k" into "100k
 * spread across the window, the rest go stale — never an overspend."
 */

const store = require('../lib/store');
const cfg = require('../config/engine');
const budgetLedger = require('./budgetLedger');

const GATEWAY_KEY = 'pace:gateway';

/** Global SMS-gateway rate limit. Returns {allowed, waitMs}. */
async function acquireGateway() {
  if (!cfg.pacing.enabled) return { allowed: true, waitMs: 0 };
  return store.acquireToken(
    GATEWAY_KEY,
    cfg.pacing.gatewayMaxPerSec,
    cfg.pacing.gatewayBurst,
    1,
    3600
  );
}

/** Views/sec this campaign should be allowed, from its live budget + CPV. */
async function campaignRatePerSec(ad) {
  const remainingBirr = await budgetLedger.remaining(ad);
  const cpv = ad.cost_per_view != null ? ad.cost_per_view : cfg.budget.defaultCostPerView;
  if (cpv <= 0) return cfg.pacing.gatewayMaxPerSec; // free view — only gateway-limited
  const affordableViews = remainingBirr / cpv;
  const windowSec = cfg.pacing.spendWindowHours * 3600;
  const rate = affordableViews / windowSec;
  // Never fully zero for an active campaign with budget; keep a trickle.
  return Math.max(rate, remainingBirr > 0 ? 0.05 : 0);
}

/**
 * Try to claim one pacing slot for a campaign. If the campaign is ahead of pace
 * this returns allowed:false and the engine should try another campaign.
 */
async function tryCampaign(ad) {
  if (!cfg.pacing.enabled) return { allowed: true, waitMs: 0 };
  const rate = await campaignRatePerSec(ad);
  if (rate <= 0) return { allowed: false, waitMs: 0 };
  // Small burst so bursts of genuine traffic aren't stuttered, but not so large
  // that a campaign can dump its budget at once.
  const burst = Math.max(1, Math.min(20, Math.ceil(rate * 5)));
  return store.acquireToken(`pace:campaign:${ad._id}`, rate, burst, 1, 3600);
}

module.exports = { acquireGateway, tryCampaign, campaignRatePerSec };
