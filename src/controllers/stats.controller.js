/**
 * stats.controller.js — Read-mostly analytics KPIs for the marketer dashboard.
 *
 * Every query here is HOT-PATH-adjacent over collections that grow into the
 * millions, so each one is:
 *   - time-bounded (an early $match / $gte on an indexed date field),
 *   - .lean() (plain objects, no Mongoose hydration),
 *   - projected (only the fields a KPI needs), and
 *   - .limit()-ed (aggregations cap their working set).
 * Indexes leaned on: watchlinks {ad_id,created_at}, {ad_id,status},
 * {marketer_id,created_at}; audits {ad_id,type,timestamp}; rewards {ad_id,granted_at}.
 */

const mongoose = require('mongoose');
const WatchLink = require('../models/watchLink.model');
const AuditLog = require('../models/audit.model');
const Ad = require('../models/ad.model');
const Reward = require('../models/reward.model');
const logger = require('../utils/logger');

// Clamp ?days=N into a sane window (1..365, default 30) so a caller can't ask
// for an unbounded scan.
function windowDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 365);
}
function sinceFrom(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
function toObjectId(id) {
  return new mongoose.Types.ObjectId(id);
}

// Per-ad watchlink funnel counts over a time window, in a single aggregation
// (early $match on {ad_id,created_at} index). Returns the raw status buckets.
async function funnelForAds(adIds, since) {
  const rows = await WatchLink.aggregate([
    { $match: { ad_id: { $in: adIds }, created_at: { $gte: since } } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        opened: { $sum: { $cond: [{ $in: ['$status', ['opened', 'started', 'completed']] }, 1, 0] } },
        started: { $sum: { $cond: [{ $in: ['$status', ['started', 'completed']] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        clicks: { $sum: { $cond: [{ $eq: ['$clicked', true] }, 1, 0] } },
      },
    },
  ]).option({ maxTimeMS: 15000 });
  return rows[0] || { total: 0, opened: 0, started: 0, completed: 0, clicks: 0 };
}

// Impressions = SMS actually dispatched (audit 'sms_sent'); fall back to
// 'link_created' when the deployment audits creation instead of dispatch.
async function impressionsForAds(adIds, since) {
  const smsSent = await AuditLog.countDocuments({
    ad_id: { $in: adIds },
    type: 'sms_sent',
    timestamp: { $gte: since },
  }).maxTimeMS(15000);
  if (smsSent > 0) return smsSent;
  return AuditLog.countDocuments({
    ad_id: { $in: adIds },
    type: 'link_created',
    timestamp: { $gte: since },
  }).maxTimeMS(15000);
}

async function rewardsForAds(adIds, since) {
  return Reward.countDocuments({
    ad_id: { $in: adIds },
    status: 'granted',
    granted_at: { $gte: since },
  }).maxTimeMS(15000);
}

// Assemble the KPI object shared by campaign + overview responses.
function buildKpis({ impressions, funnel, rewards, cpv }) {
  const completions = funnel.completed || 0;
  const clicks = funnel.clicks || 0;
  const spend = completions * (cpv || 0);
  const completionRate = impressions > 0 ? completions / impressions : 0;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const cpv_effective = completions > 0 ? spend / completions : 0;
  return {
    impressions,
    opens: funnel.opened || 0,
    starts: funnel.started || 0,
    completions,
    clicks,
    rewards,
    spend,
    completion_rate: completionRate,
    ctr,
    cpv: cpv_effective,
  };
}

/**
 * GET /stats/campaign/:adId?days=N
 * KPIs for a single ad over the window (default 30d).
 */
exports.getCampaignStats = async (req, res, next) => {
  try {
    const { adId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(adId)) {
      return res.status(400).json({ status: false, error: 'Invalid ad id' });
    }
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);
    const adOid = toObjectId(adId);

    const ad = await Ad.findById(adId)
      .select('campaign_name title cost_per_view remaining_budget budget_allocation marketer_id status')
      .lean();
    if (!ad) return res.status(404).json({ status: false, error: 'Campaign not found' });

    const cpv = ad.cost_per_view != null ? ad.cost_per_view : 0;
    const [impressions, funnel, rewards] = await Promise.all([
      impressionsForAds([adOid], since),
      funnelForAds([adOid], since),
      rewardsForAds([adOid], since),
    ]);

    const kpis = buildKpis({ impressions, funnel, rewards, cpv });

    logger.info(`StatsController.getCampaignStats - ad ${adId} (${days}d): imp=${impressions} comp=${funnel.completed}`);
    res.json({
      status: true,
      ad_id: adId,
      days,
      campaign_name: ad.campaign_name,
      title: ad.title,
      status: ad.status,
      remaining_budget: ad.remaining_budget || 0,
      budget_allocation: ad.budget_allocation || 0,
      ...kpis,
    });
  } catch (err) {
    logger.error(`StatsController.getCampaignStats - Error: ${err.message}`);
    next(err);
  }
};

/**
 * GET /stats/campaign/:adId/timeseries?days=N
 * Daily buckets built by $group on created_at truncated to a UTC day.
 */
exports.getCampaignTimeseries = async (req, res, next) => {
  try {
    const { adId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(adId)) {
      return res.status(400).json({ status: false, error: 'Invalid ad id' });
    }
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);
    const adOid = toObjectId(adId);

    // $match FIRST (indexed {ad_id,created_at}) so we only truncate/group the
    // window's rows, never the whole collection. Cap buckets defensively.
    const rows = await WatchLink.aggregate([
      { $match: { ad_id: adOid, created_at: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'UTC' } },
          views: { $sum: 1 },
          opens: { $sum: { $cond: [{ $in: ['$status', ['opened', 'started', 'completed']] }, 1, 0] } },
          starts: { $sum: { $cond: [{ $in: ['$status', ['started', 'completed']] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          clicks: { $sum: { $cond: [{ $eq: ['$clicked', true] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 366 },
    ]).option({ maxTimeMS: 15000 });

    const series = rows.map((r) => ({
      date: r._id,
      views: r.views,
      opens: r.opens,
      starts: r.starts,
      completed: r.completed,
      clicks: r.clicks,
    }));

    logger.info(`StatsController.getCampaignTimeseries - ad ${adId} (${days}d): ${series.length} buckets`);
    res.json({ status: true, ad_id: adId, days, series });
  } catch (err) {
    logger.error(`StatsController.getCampaignTimeseries - Error: ${err.message}`);
    next(err);
  }
};

/**
 * GET /stats/marketer/:marketerId/overview?days=N
 * Totals across a marketer's ads + a per-campaign breakdown, and wallet spend/remaining.
 */
exports.getMarketerOverview = async (req, res, next) => {
  try {
    const { marketerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(marketerId)) {
      return res.status(400).json({ status: false, error: 'Invalid marketer id' });
    }
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);
    const marketerOid = toObjectId(marketerId);

    // Bounded set of the marketer's ads (projected, lean, limited).
    const ads = await Ad.find({ marketer_id: marketerOid })
      .select('campaign_name title cost_per_view remaining_budget budget_allocation status')
      .limit(500)
      .lean();

    if (!ads.length) {
      return res.json({
        status: true,
        marketer_id: marketerId,
        days,
        totals: buildKpis({ impressions: 0, funnel: {}, rewards: 0, cpv: 0 }),
        spend: 0,
        remaining: 0,
        budget_allocation: 0,
        campaigns: [],
      });
    }

    const adIds = ads.map((a) => a._id);
    const cpvById = new Map(ads.map((a) => [a._id.toString(), a.cost_per_view != null ? a.cost_per_view : 0]));

    // Per-campaign funnel in ONE aggregation ($group by ad_id), plus per-campaign
    // impressions and rewards — all time-bounded on their indexed date fields.
    const [funnelRows, impressionRows, rewardRows] = await Promise.all([
      WatchLink.aggregate([
        { $match: { ad_id: { $in: adIds }, created_at: { $gte: since } } },
        {
          $group: {
            _id: '$ad_id',
            total: { $sum: 1 },
            opened: { $sum: { $cond: [{ $in: ['$status', ['opened', 'started', 'completed']] }, 1, 0] } },
            started: { $sum: { $cond: [{ $in: ['$status', ['started', 'completed']] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            clicks: { $sum: { $cond: [{ $eq: ['$clicked', true] }, 1, 0] } },
          },
        },
      ]).option({ maxTimeMS: 20000 }),
      AuditLog.aggregate([
        { $match: { ad_id: { $in: adIds }, type: { $in: ['sms_sent', 'link_created'] }, timestamp: { $gte: since } } },
        {
          $group: {
            _id: '$ad_id',
            sms_sent: { $sum: { $cond: [{ $eq: ['$type', 'sms_sent'] }, 1, 0] } },
            link_created: { $sum: { $cond: [{ $eq: ['$type', 'link_created'] }, 1, 0] } },
          },
        },
      ]).option({ maxTimeMS: 20000 }),
      Reward.aggregate([
        { $match: { ad_id: { $in: adIds }, status: 'granted', granted_at: { $gte: since } } },
        { $group: { _id: '$ad_id', rewards: { $sum: 1 } } },
      ]).option({ maxTimeMS: 20000 }),
    ]);

    const funnelById = new Map(funnelRows.map((r) => [r._id.toString(), r]));
    const impById = new Map(impressionRows.map((r) => [r._id.toString(), r]));
    const rewardById = new Map(rewardRows.map((r) => [r._id.toString(), r.rewards]));

    let spend = 0;
    let remaining = 0;
    let budgetAllocation = 0;
    const totalsAgg = { impressions: 0, opens: 0, starts: 0, completions: 0, clicks: 0, rewards: 0, spend: 0 };

    const campaigns = ads.map((ad) => {
      const id = ad._id.toString();
      const cpv = cpvById.get(id) || 0;
      const f = funnelById.get(id) || { total: 0, opened: 0, started: 0, completed: 0, clicks: 0 };
      const imp = impById.get(id) || { sms_sent: 0, link_created: 0 };
      const impressions = imp.sms_sent > 0 ? imp.sms_sent : imp.link_created;
      const rewards = rewardById.get(id) || 0;

      const kpis = buildKpis({
        impressions,
        funnel: { opened: f.opened, started: f.started, completed: f.completed, clicks: f.clicks },
        rewards,
        cpv,
      });

      remaining += ad.remaining_budget || 0;
      budgetAllocation += ad.budget_allocation || 0;
      spend += kpis.spend;

      totalsAgg.impressions += kpis.impressions;
      totalsAgg.opens += kpis.opens;
      totalsAgg.starts += kpis.starts;
      totalsAgg.completions += kpis.completions;
      totalsAgg.clicks += kpis.clicks;
      totalsAgg.rewards += kpis.rewards;
      totalsAgg.spend += kpis.spend;

      return {
        ad_id: id,
        campaign_name: ad.campaign_name,
        title: ad.title,
        status: ad.status,
        remaining_budget: ad.remaining_budget || 0,
        budget_allocation: ad.budget_allocation || 0,
        ...kpis,
      };
    });

    const totals = {
      ...totalsAgg,
      completion_rate: totalsAgg.impressions > 0 ? totalsAgg.completions / totalsAgg.impressions : 0,
      ctr: totalsAgg.impressions > 0 ? totalsAgg.clicks / totalsAgg.impressions : 0,
      cpv: totalsAgg.completions > 0 ? totalsAgg.spend / totalsAgg.completions : 0,
    };

    logger.info(`StatsController.getMarketerOverview - marketer ${marketerId} (${days}d): ${campaigns.length} campaigns`);
    res.json({
      status: true,
      marketer_id: marketerId,
      days,
      totals,
      spend,
      remaining,
      budget_allocation: budgetAllocation,
      campaigns,
    });
  } catch (err) {
    logger.error(`StatsController.getMarketerOverview - Error: ${err.message}`);
    next(err);
  }
};
