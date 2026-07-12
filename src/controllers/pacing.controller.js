/**
 * pacing.controller.js — Is a campaign spending its budget on schedule?
 *
 * Reuses the live pacing service (target rate) + budget ledger (live remaining)
 * rather than recomputing, so the dashboard shows exactly what the dispatch
 * engine sees. "spent_today" is derived from today's completed watchlinks × CPV
 * (time-bounded on the {ad_id,created_at} index) — a cheap, per-campaign proxy
 * for durable spend without scanning the transaction ledger.
 */

const mongoose = require('mongoose');
const Ad = require('../models/ad.model');
const WatchLink = require('../models/watchLink.model');
const pacing = require('../services/pacing');
const budgetLedger = require('../services/budgetLedger');
const cfg = require('../config/engine');
const logger = require('../utils/logger');

function toObjectId(id) {
  return new mongoose.Types.ObjectId(id);
}
function startOfTodayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Completed watchlinks since midnight UTC × CPV. Time-bounded + indexed.
async function spentTodayForAd(adOid, cpv) {
  if (!cpv || cpv <= 0) return 0;
  const completed = await WatchLink.countDocuments({
    ad_id: adOid,
    status: 'completed',
    created_at: { $gte: startOfTodayUTC() },
  }).maxTimeMS(15000);
  return completed * cpv;
}

// Elapsed fraction of the spend window that has passed today. Used to judge
// whether spent_today is "on pace" with the smoothed target.
function windowElapsedSeconds() {
  const windowSec = cfg.pacing.spendWindowHours * 3600;
  const elapsed = (Date.now() - startOfTodayUTC().getTime()) / 1000;
  return Math.max(0, Math.min(elapsed, windowSec));
}

/**
 * GET /pacing/campaign/:adId
 * => { remaining_budget, target_rate_per_sec, spent_today, on_pace }
 */
exports.getCampaignPacing = async (req, res, next) => {
  try {
    const { adId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(adId)) {
      return res.status(400).json({ status: false, error: 'Invalid ad id' });
    }

    const ad = await Ad.findById(adId)
      .select('cost_per_view remaining_budget marketer_id status')
      .lean();
    if (!ad) return res.status(404).json({ status: false, error: 'Campaign not found' });

    const cpv = ad.cost_per_view != null ? ad.cost_per_view : cfg.budget.defaultCostPerView;
    const [remaining, targetRate, spentToday] = await Promise.all([
      budgetLedger.remaining(ad),
      pacing.campaignRatePerSec(ad),
      spentTodayForAd(toObjectId(adId), cpv),
    ]);

    // Expected spend by now = target views/sec × elapsed window seconds × CPV.
    // On pace if actual spend is within ±25% of expected (or if there's nothing
    // to pace because the target rate is ~0).
    const expectedSpend = targetRate * windowElapsedSeconds() * cpv;
    let onPace = true;
    if (expectedSpend > 0) {
      const ratio = spentToday / expectedSpend;
      onPace = ratio >= 0.75 && ratio <= 1.25;
    }

    logger.info(`PacingController.getCampaignPacing - ad ${adId}: rate=${targetRate.toFixed(4)}/s spentToday=${spentToday} onPace=${onPace}`);
    res.json({
      status: true,
      ad_id: adId,
      remaining_budget: remaining,
      target_rate_per_sec: targetRate,
      spent_today: spentToday,
      on_pace: onPace,
    });
  } catch (err) {
    logger.error(`PacingController.getCampaignPacing - Error: ${err.message}`);
    next(err);
  }
};

/**
 * GET /pacing/alerts
 * Marketer's campaigns that are over/under pace or near budget depletion.
 * Scoped to req.user.id (the authenticated marketer), bounded, and lean.
 */
exports.getPacingAlerts = async (req, res, next) => {
  try {
    const marketerId = req.user && req.user.id;
    if (!marketerId || !mongoose.Types.ObjectId.isValid(marketerId)) {
      return res.status(400).json({ status: false, error: 'Invalid marketer context' });
    }

    // Only active campaigns can be off-pace; bound the working set.
    const ads = await Ad.find({ marketer_id: toObjectId(marketerId), status: 'active' })
      .select('campaign_name title cost_per_view remaining_budget budget_allocation status')
      .limit(200)
      .lean();

    const elapsed = windowElapsedSeconds();
    const alerts = [];

    for (const ad of ads) {
      const cpv = ad.cost_per_view != null ? ad.cost_per_view : cfg.budget.defaultCostPerView;
      const [remaining, targetRate, spentToday] = await Promise.all([
        budgetLedger.remaining(ad),
        pacing.campaignRatePerSec(ad),
        spentTodayForAd(ad._id, cpv),
      ]);

      const expectedSpend = targetRate * elapsed * cpv;
      const alloc = ad.budget_allocation || 0;
      const depletionPct = alloc > 0 ? remaining / alloc : 1;

      const issues = [];
      if (expectedSpend > 0) {
        const ratio = spentToday / expectedSpend;
        if (ratio > 1.25) issues.push('over_pace');
        else if (ratio < 0.75) issues.push('under_pace');
      }
      // "Near depletion": under 10% of allocation left (and something allocated).
      if (alloc > 0 && depletionPct <= 0.1) issues.push('near_depletion');

      if (issues.length) {
        alerts.push({
          ad_id: ad._id.toString(),
          campaign_name: ad.campaign_name,
          title: ad.title,
          status: ad.status,
          remaining_budget: remaining,
          budget_allocation: alloc,
          target_rate_per_sec: targetRate,
          spent_today: spentToday,
          expected_spend: expectedSpend,
          depletion_pct: depletionPct,
          alerts: issues,
        });
      }
    }

    logger.info(`PacingController.getPacingAlerts - marketer ${marketerId}: ${alerts.length}/${ads.length} campaigns flagged`);
    res.json({ status: true, marketer_id: marketerId, count: alerts.length, alerts });
  } catch (err) {
    logger.error(`PacingController.getPacingAlerts - Error: ${err.message}`);
    next(err);
  }
};
