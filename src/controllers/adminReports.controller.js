/**
 * adminReports.controller.js — Admin-only aggregated reporting endpoints.
 *
 * Every handler here runs over collections that grow into the millions
 * (watchlinks, audits, rewards, frauddetections), so each aggregation is:
 *   - ADMIN-GATED (verifyToken + isAdmin, applied at the route layer),
 *   - TIME-BOUNDED via ?days=N clamped to 1..365 (default 30) — an early
 *     $match on an indexed date field so no query can trigger a full scan,
 *   - .lean()/aggregate() (plain objects, no Mongoose hydration),
 *   - projected + .limit()-ed (only the fields a KPI needs, capped working set),
 *   - guarded with maxTimeMS so a pathological query can't pin a mongod core.
 *
 * Indexes leaned on:
 *   watchlinks : {ad_id,created_at}, {marketer_id,created_at}, {status,created_at}
 *   audits     : {ad_id,type,timestamp}, {type,timestamp}, {msisdn,timestamp}
 *   rewards    : {ad_id,granted_at}, {status,granted_at}
 *   frauddetections : {created_at}, {action,created_at}, {stage,created_at}
 *   marketertransactions : {marketer_id,created_at}, {type,created_at}
 *
 * Response envelope (project convention):
 *   success → res.json({ status: true, ... })
 *   failure → res.status(code).json({ status: false, error })
 *   thrown  → try/catch → next(err)
 */

const mongoose = require('mongoose');
const WatchLink = require('../models/watchLink.model');
const Reward = require('../models/reward.model');
const AuditLog = require('../models/audit.model');
const MarketerTransaction = require('../models/marketerTransaction.model');
const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const FraudDetection = require('../models/fraudDetection.model');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Wall-clock budget for any single aggregation. Bounds worst-case latency and
// prevents a runaway pipeline from holding a mongod core hostage.
const MAX_TIME_MS = 20000;

// Clamp ?days=N into a sane window (1..365, default 30) so a caller can't ask
// for an unbounded scan.
function windowDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 365);
}

// Clamp ?weeks=N for the cohort report (1..52, default 8).
function windowWeeks(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(n, 52);
}

function sinceFrom(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sinceFromWeeks(weeks) {
  const d = new Date();
  d.setDate(d.getDate() - weeks * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function pct(part, whole) {
  if (!whole) return 0;
  return round2((part / whole) * 100);
}

// ---------------------------------------------------------------------------
// GET /admin/reports/revenue
// Spend / revenue / ARPU / top-spenders / budget utilization.
// Revenue is derived from committed watchlink spend (reserved_amount on
// committed links) cross-checked against marketer deduction transactions.
// ---------------------------------------------------------------------------
exports.revenue = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const [
      spendAgg,
      committedAgg,
      topSpendersAgg,
      utilizationAgg,
      activeMarketers
    ] = await Promise.all([
      // Marketer deductions (actual money spent) over the window.
      MarketerTransaction.aggregate([
        { $match: { type: 'deduction', created_at: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Committed spend from completed watchlinks (reserved→committed budget).
      WatchLink.aggregate([
        { $match: { created_at: { $gte: since }, budget_state: 'committed' } },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$reserved_amount' },
            completions: { $sum: 1 }
          }
        }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Top spenders by deduction volume in-window.
      MarketerTransaction.aggregate([
        { $match: { type: 'deduction', created_at: { $gte: since } } },
        {
          $group: {
            _id: '$marketer_id',
            spend: { $sum: '$amount' },
            deductions: { $sum: 1 }
          }
        },
        { $sort: { spend: -1 } },
        { $limit: 10 }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Budget utilization across active campaigns (allocation vs remaining).
      Ad.aggregate([
        { $match: { status: { $in: ['active', 'paused'] } } },
        {
          $group: {
            _id: null,
            allocated: { $sum: { $ifNull: ['$budget_allocation', 0] } },
            remaining: { $sum: { $ifNull: ['$remaining_budget', 0] } },
            campaigns: { $sum: 1 }
          }
        }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      Marketer.countDocuments({ status: 'active' }).maxTimeMS(MAX_TIME_MS).catch(() => 0)
    ]);

    const totalSpend = round2(spendAgg[0]?.total || 0);
    const revenue = round2(committedAgg[0]?.revenue || 0);
    const completions = committedAgg[0]?.completions || 0;
    const arpu = round2(activeMarketers ? totalSpend / activeMarketers : 0);

    // Hydrate top-spender names in a single lookup.
    const spenderIds = topSpendersAgg.map(s => s._id).filter(Boolean);
    const spenderDocs = spenderIds.length
      ? await Marketer.find({ _id: { $in: spenderIds } })
          .select('name company_name email')
          .lean()
          .maxTimeMS(MAX_TIME_MS)
      : [];
    const spenderMap = new Map(spenderDocs.map(m => [m._id.toString(), m]));
    const topSpenders = topSpendersAgg.map(s => {
      const m = s._id ? spenderMap.get(s._id.toString()) : null;
      return {
        marketer_id: s._id,
        name: m?.company_name || m?.name || 'Unknown',
        email: m?.email || null,
        spend: round2(s.spend),
        deductions: s.deductions
      };
    });

    const allocated = round2(utilizationAgg[0]?.allocated || 0);
    const remaining = round2(utilizationAgg[0]?.remaining || 0);
    const consumed = round2(allocated - remaining);

    logger.info(`AdminReports.revenue (${days}d): spend=${totalSpend} revenue=${revenue} arpu=${arpu}`);

    return res.json({
      status: true,
      days,
      since,
      revenue: {
        total_spend: totalSpend,
        committed_revenue: revenue,
        completions,
        deduction_count: spendAgg[0]?.count || 0,
        arpu,
        active_marketers: activeMarketers
      },
      utilization: {
        allocated,
        remaining,
        consumed,
        utilization_pct: pct(consumed, allocated),
        campaigns: utilizationAgg[0]?.campaigns || 0
      },
      top_spenders: topSpenders
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/campaigns
// Per-ad KPI leaderboard: impressions, funnel, completion rate, rewards, spend.
// ---------------------------------------------------------------------------
exports.campaigns = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    // Per-ad funnel + spend from watchlinks (early $match on {status,created_at}
    // / {ad_id,created_at}). Capped to the top 50 by volume.
    const perAd = await WatchLink.aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id: '$ad_id',
          total: { $sum: 1 },
          opened: { $sum: { $cond: [{ $in: ['$status', ['opened', 'started', 'completed']] }, 1, 0] } },
          started: { $sum: { $cond: [{ $in: ['$status', ['started', 'completed']] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          clicks: { $sum: { $cond: ['$clicked', 1, 0] } },
          spend: { $sum: { $cond: [{ $eq: ['$budget_state', 'committed'] }, '$reserved_amount', 0] } },
          flagged: { $sum: { $cond: ['$has_fraud', 1, 0] } }
        }
      },
      { $sort: { completed: -1, total: -1 } },
      { $limit: 50 }
    ]).option({ maxTimeMS: MAX_TIME_MS });

    // Rewards granted per ad, same window.
    const rewardsAgg = await Reward.aggregate([
      { $match: { granted_at: { $gte: since } } },
      {
        $group: {
          _id: '$ad_id',
          granted: { $sum: { $cond: [{ $eq: ['$status', 'granted'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
        }
      }
    ]).option({ maxTimeMS: MAX_TIME_MS });
    const rewardMap = new Map(rewardsAgg.map(r => [String(r._id), r]));

    const adIds = perAd.map(a => a._id).filter(Boolean);
    const adDocs = adIds.length
      ? await Ad.find({ _id: { $in: adIds } })
          .select('campaign_name title marketer_id status cost_per_view rate_tier')
          .populate('marketer_id', 'name company_name')
          .lean()
          .maxTimeMS(MAX_TIME_MS)
      : [];
    const adMap = new Map(adDocs.map(a => [a._id.toString(), a]));

    const leaderboard = perAd.map(a => {
      const ad = a._id ? adMap.get(a._id.toString()) : null;
      const rw = rewardMap.get(String(a._id)) || { granted: 0, failed: 0 };
      return {
        ad_id: a._id,
        campaign_name: ad?.campaign_name || ad?.title || 'Untitled',
        marketer: ad?.marketer_id?.company_name || ad?.marketer_id?.name || 'Unknown',
        status: ad?.status || 'unknown',
        rate_tier: ad?.rate_tier || 'normal',
        impressions: a.total,
        opened: a.opened,
        started: a.started,
        completed: a.completed,
        clicks: a.clicks,
        completion_rate: pct(a.completed, a.total),
        ctr: pct(a.clicks, a.total),
        rewards_granted: rw.granted,
        rewards_failed: rw.failed,
        flagged: a.flagged,
        spend: round2(a.spend)
      };
    });

    logger.info(`AdminReports.campaigns (${days}d): ${leaderboard.length} campaigns`);

    return res.json({ status: true, days, since, count: leaderboard.length, campaigns: leaderboard });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/marketers
// Per-marketer scorecards: campaigns, impressions, completions, spend, rewards.
// ---------------------------------------------------------------------------
exports.marketers = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const [engagementAgg, spendAgg] = await Promise.all([
      // Per-marketer engagement from watchlinks ({marketer_id,created_at}).
      WatchLink.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: '$marketer_id',
            impressions: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            clicks: { $sum: { $cond: ['$clicked', 1, 0] } },
            reach: { $addToSet: '$msisdn' },
            spend: { $sum: { $cond: [{ $eq: ['$budget_state', 'committed'] }, '$reserved_amount', 0] } }
          }
        },
        {
          $project: {
            impressions: 1,
            completed: 1,
            clicks: 1,
            spend: 1,
            unique_reach: { $size: '$reach' }
          }
        },
        { $sort: { completed: -1, impressions: -1 } },
        { $limit: 50 }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Per-marketer deduction totals ({type,created_at}).
      MarketerTransaction.aggregate([
        { $match: { type: 'deduction', created_at: { $gte: since } } },
        { $group: { _id: '$marketer_id', deductions: { $sum: '$amount' } } }
      ]).option({ maxTimeMS: MAX_TIME_MS })
    ]);

    const deductionMap = new Map(spendAgg.map(d => [String(d._id), d.deductions]));

    const marketerIds = engagementAgg.map(m => m._id).filter(Boolean);
    const [marketerDocs, adCounts] = await Promise.all([
      marketerIds.length
        ? Marketer.find({ _id: { $in: marketerIds } })
            .select('name company_name email status remaining_budget total_budget')
            .lean()
            .maxTimeMS(MAX_TIME_MS)
        : [],
      marketerIds.length
        ? Ad.aggregate([
            { $match: { marketer_id: { $in: marketerIds } } },
            { $group: { _id: '$marketer_id', campaigns: { $sum: 1 } } }
          ]).option({ maxTimeMS: MAX_TIME_MS })
        : []
    ]);
    const marketerMap = new Map(marketerDocs.map(m => [m._id.toString(), m]));
    const campaignMap = new Map(adCounts.map(c => [String(c._id), c.campaigns]));

    const scorecards = engagementAgg.map(m => {
      const doc = m._id ? marketerMap.get(m._id.toString()) : null;
      return {
        marketer_id: m._id,
        name: doc?.company_name || doc?.name || 'Unknown',
        email: doc?.email || null,
        status: doc?.status || 'unknown',
        campaigns: campaignMap.get(String(m._id)) || 0,
        impressions: m.impressions,
        completed: m.completed,
        clicks: m.clicks,
        unique_reach: m.unique_reach,
        completion_rate: pct(m.completed, m.impressions),
        ctr: pct(m.clicks, m.impressions),
        committed_spend: round2(m.spend),
        deduction_spend: round2(deductionMap.get(String(m._id)) || 0),
        remaining_budget: round2(doc?.remaining_budget || 0),
        total_budget: round2(doc?.total_budget || 0)
      };
    });

    logger.info(`AdminReports.marketers (${days}d): ${scorecards.length} marketers`);

    return res.json({ status: true, days, since, count: scorecards.length, marketers: scorecards });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/rewards
// Granted / failed / pending broken down by status and offer type.
// ---------------------------------------------------------------------------
exports.rewards = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const [byStatus, byOffer, daily] = await Promise.all([
      // Status split ({status,granted_at}).
      Reward.aggregate([
        { $match: { granted_at: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Top offer types.
      Reward.aggregate([
        { $match: { granted_at: { $gte: since } } },
        {
          $group: {
            _id: '$offer_id',
            total: { $sum: 1 },
            granted: { $sum: { $cond: [{ $eq: ['$status', 'granted'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
          }
        },
        { $sort: { total: -1 } },
        { $limit: 25 }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Daily granted/failed trend.
      Reward.aggregate([
        { $match: { granted_at: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$granted_at' } },
            granted: { $sum: { $cond: [{ $eq: ['$status', 'granted'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]).option({ maxTimeMS: MAX_TIME_MS })
    ]);

    const statusMap = byStatus.reduce((acc, s) => {
      acc[s._id || 'unknown'] = s.count;
      return acc;
    }, { granted: 0, failed: 0, pending: 0 });
    const totalRewards = byStatus.reduce((sum, s) => sum + s.count, 0);

    logger.info(`AdminReports.rewards (${days}d): total=${totalRewards}`);

    return res.json({
      status: true,
      days,
      since,
      totals: {
        total: totalRewards,
        granted: statusMap.granted,
        failed: statusMap.failed,
        pending: statusMap.pending,
        success_rate: pct(statusMap.granted, totalRewards)
      },
      by_offer: byOffer.map(o => ({
        offer_id: o._id || 'unknown',
        total: o.total,
        granted: o.granted,
        failed: o.failed,
        success_rate: pct(o.granted, o.total)
      })),
      daily: daily.map(d => ({ date: d._id, granted: d.granted, failed: d.failed, pending: d.pending }))
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/delivery
// Audit funnel: sms_sent → opened → started → completed, with drop-off.
// Sourced from the audit log ({type,timestamp}).
// ---------------------------------------------------------------------------
exports.delivery = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const STAGES = ['sms_sent', 'opened', 'started', 'completed'];

    const byType = await AuditLog.aggregate([
      { $match: { timestamp: { $gte: since }, type: { $in: STAGES } } },
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]).option({ maxTimeMS: MAX_TIME_MS });

    const counts = byType.reduce((acc, t) => {
      acc[t._id] = t.count;
      return acc;
    }, {});

    // Build an ordered funnel with step + overall conversion.
    const top = counts[STAGES[0]] || 0;
    let prev = top;
    const funnel = STAGES.map((stage, i) => {
      const count = counts[stage] || 0;
      const row = {
        stage,
        count,
        step_conversion: i === 0 ? 100 : pct(count, prev),
        overall_conversion: pct(count, top),
        drop_off: i === 0 ? 0 : Math.max(prev - count, 0)
      };
      prev = count;
      return row;
    });

    logger.info(`AdminReports.delivery (${days}d): sent=${top} completed=${counts.completed || 0}`);

    return res.json({
      status: true,
      days,
      since,
      funnel,
      summary: {
        sms_sent: top,
        completed: counts.completed || 0,
        end_to_end_conversion: pct(counts.completed || 0, top)
      }
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/engagement
// Unique msisdns, view frequency, hourly + day-of-week distribution.
// Watchlinks for reach/frequency, audits for temporal buckets.
// ---------------------------------------------------------------------------
exports.engagement = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const [reachAgg, frequencyAgg, temporalAgg] = await Promise.all([
      // Unique msisdns + total impressions ({status,created_at} scan window).
      WatchLink.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: null,
            impressions: { $sum: 1 },
            reach: { $addToSet: '$msisdn' }
          }
        },
        { $project: { impressions: 1, unique_msisdns: { $size: '$reach' } } }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Frequency distribution: how many watches per unique msisdn, bucketed.
      WatchLink.aggregate([
        { $match: { created_at: { $gte: since } } },
        { $group: { _id: '$msisdn', watches: { $sum: 1 } } },
        {
          $bucket: {
            groupBy: '$watches',
            boundaries: [1, 2, 3, 5, 10, 25, 100],
            default: '100+',
            output: { subscribers: { $sum: 1 } }
          }
        }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Hour-of-day + day-of-week buckets from the audit log ({type,timestamp}).
      AuditLog.aggregate([
        { $match: { timestamp: { $gte: since }, type: { $in: ['opened', 'started', 'completed'] } } },
        {
          $group: {
            _id: {
              hour: { $hour: '$timestamp' },
              dow: { $dayOfWeek: '$timestamp' }
            },
            count: { $sum: 1 }
          }
        }
      ]).option({ maxTimeMS: MAX_TIME_MS })
    ]);

    const impressions = reachAgg[0]?.impressions || 0;
    const uniqueMsisdns = reachAgg[0]?.unique_msisdns || 0;

    // Fold temporal buckets into hourly (0..23) and dow (1..7, Mongo Sun=1).
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = dowNames.map((name, i) => ({ dow: i + 1, name, count: 0 }));
    for (const t of temporalAgg) {
      const h = t._id?.hour;
      const d = t._id?.dow;
      if (Number.isInteger(h) && h >= 0 && h < 24) hourly[h].count += t.count;
      if (Number.isInteger(d) && d >= 1 && d <= 7) dow[d - 1].count += t.count;
    }

    const frequency = frequencyAgg.map(b => ({
      bucket: b._id === '100+' ? '100+' : String(b._id),
      subscribers: b.subscribers
    }));

    logger.info(`AdminReports.engagement (${days}d): reach=${uniqueMsisdns} impressions=${impressions}`);

    return res.json({
      status: true,
      days,
      since,
      reach: {
        unique_msisdns: uniqueMsisdns,
        impressions,
        avg_frequency: round2(uniqueMsisdns ? impressions / uniqueMsisdns : 0)
      },
      frequency,
      hourly,
      day_of_week: dow
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/cohorts?weeks=N
// Weekly first-seen cohorts + retention across subsequent weeks.
// First-seen = earliest watchlink per msisdn within the window.
// ---------------------------------------------------------------------------
exports.cohorts = async (req, res, next) => {
  try {
    const weeks = windowWeeks(req.query.weeks);
    const since = sinceFromWeeks(weeks);

    // Per-msisdn: first-seen week + the set of distinct active weeks.
    // %G-%V gives ISO year-week so cohorts align to week boundaries.
    const rows = await WatchLink.aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id: '$msisdn',
          first_seen: { $min: '$created_at' },
          weeks_active: {
            $addToSet: { $dateToString: { format: '%G-%V', date: '$created_at' } }
          }
        }
      },
      {
        $project: {
          cohort: { $dateToString: { format: '%G-%V', date: '$first_seen' } },
          first_seen: 1,
          weeks_active: 1
        }
      }
    ]).option({ maxTimeMS: MAX_TIME_MS });

    // Assemble cohort → { size, retention[offsetWeek] } in JS. Offsets are
    // computed from the ISO week difference between first-seen and active week.
    const isoWeekIndex = (yw) => {
      // yw = "2026-27" (ISO year-week) → a monotonic integer for diffing.
      const [y, w] = yw.split('-').map(Number);
      return y * 53 + w;
    };

    const cohortMap = new Map();
    for (const r of rows) {
      if (!r.cohort) continue;
      const base = isoWeekIndex(r.cohort);
      let c = cohortMap.get(r.cohort);
      if (!c) {
        c = { cohort: r.cohort, size: 0, retained: new Map() };
        cohortMap.set(r.cohort, c);
      }
      c.size += 1;
      for (const wk of r.weeks_active || []) {
        const offset = isoWeekIndex(wk) - base;
        if (offset < 0 || offset >= weeks) continue;
        c.retained.set(offset, (c.retained.get(offset) || 0) + 1);
      }
    }

    const cohortList = [...cohortMap.values()]
      .sort((a, b) => (a.cohort < b.cohort ? -1 : 1))
      .map(c => {
        const retention = [];
        for (let off = 0; off < weeks; off++) {
          const r = c.retained.get(off) || 0;
          retention.push({ week_offset: off, retained: r, pct: pct(r, c.size) });
        }
        return { cohort: c.cohort, size: c.size, retention };
      });

    logger.info(`AdminReports.cohorts (${weeks}w): ${cohortList.length} cohorts`);

    return res.json({ status: true, weeks, since, count: cohortList.length, cohorts: cohortList });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/geo
// Group watchlinks by location.category / location.region.
// ---------------------------------------------------------------------------
exports.geo = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const [byCategory, byRegion] = await Promise.all([
      WatchLink.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: { $ifNull: ['$location.category', 'unknown'] },
            impressions: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            reach: { $addToSet: '$msisdn' }
          }
        },
        { $project: { impressions: 1, completed: 1, unique_reach: { $size: '$reach' } } },
        { $sort: { impressions: -1 } },
        { $limit: 50 }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      WatchLink.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: { $ifNull: ['$location.region', 'unknown'] },
            impressions: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            reach: { $addToSet: '$msisdn' }
          }
        },
        { $project: { impressions: 1, completed: 1, unique_reach: { $size: '$reach' } } },
        { $sort: { impressions: -1 } },
        { $limit: 50 }
      ]).option({ maxTimeMS: MAX_TIME_MS })
    ]);

    const shape = (rows) => rows.map(r => ({
      key: r._id,
      impressions: r.impressions,
      completed: r.completed,
      unique_reach: r.unique_reach,
      completion_rate: pct(r.completed, r.impressions)
    }));

    logger.info(`AdminReports.geo (${days}d): ${byCategory.length} categories, ${byRegion.length} regions`);

    return res.json({
      status: true,
      days,
      since,
      by_category: shape(byCategory),
      by_region: shape(byRegion)
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/devices
// Group watchlinks by device_info brand / model / type.
// ---------------------------------------------------------------------------
exports.devices = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const byField = (field) => WatchLink.aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id: { $ifNull: [`$device_info.${field}`, 'unknown'] },
          impressions: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
        }
      },
      { $sort: { impressions: -1 } },
      { $limit: 50 }
    ]).option({ maxTimeMS: MAX_TIME_MS });

    const [byBrand, byModel, byType] = await Promise.all([
      byField('brand'),
      byField('model'),
      byField('type')
    ]);

    const shape = (rows) => rows.map(r => ({
      key: r._id,
      impressions: r.impressions,
      completed: r.completed,
      completion_rate: pct(r.completed, r.impressions)
    }));

    logger.info(`AdminReports.devices (${days}d): ${byBrand.length} brands`);

    return res.json({
      status: true,
      days,
      since,
      by_brand: shape(byBrand),
      by_model: shape(byModel),
      by_type: shape(byType)
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// GET /admin/reports/risk
// FraudDetections grouped by signal / action / stage over time + score buckets.
// ---------------------------------------------------------------------------
exports.risk = async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const since = sinceFrom(days);

    const [byAction, byStage, bySignal, scoreBuckets, daily, totals] = await Promise.all([
      // Action split ({action,created_at}).
      FraudDetection.aggregate([
        { $match: { created_at: { $gte: since } } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Stage split ({stage,created_at}).
      FraudDetection.aggregate([
        { $match: { created_at: { $gte: since } } },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Signal frequency — unwind the signals array, count by signal id.
      FraudDetection.aggregate([
        { $match: { created_at: { $gte: since } } },
        { $unwind: '$signals' },
        {
          $group: {
            _id: '$signals.id',
            occurrences: { $sum: 1 },
            avg_weight: { $avg: '$signals.weight' }
          }
        },
        { $sort: { occurrences: -1 } },
        { $limit: 25 }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Score distribution buckets.
      FraudDetection.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $bucket: {
            groupBy: { $ifNull: ['$score', 0] },
            boundaries: [0, 20, 40, 60, 80, 100],
            default: '100+',
            output: { count: { $sum: 1 } }
          }
        }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      // Daily detection trend by action severity.
      FraudDetection.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
            total: { $sum: 1 },
            hard_block: { $sum: { $cond: [{ $eq: ['$action', 'hard_block'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]).option({ maxTimeMS: MAX_TIME_MS }),

      FraudDetection.countDocuments({ created_at: { $gte: since } }).maxTimeMS(MAX_TIME_MS).catch(() => 0)
    ]);

    const mapKV = (rows) => rows.map(r => ({ key: r._id || 'unknown', count: r.count }));

    logger.info(`AdminReports.risk (${days}d): total=${totals}`);

    return res.json({
      status: true,
      days,
      since,
      total_detections: totals,
      by_action: mapKV(byAction),
      by_stage: mapKV(byStage),
      by_signal: bySignal.map(s => ({
        signal: s._id || 'unknown',
        occurrences: s.occurrences,
        avg_weight: round2(s.avg_weight)
      })),
      score_buckets: scoreBuckets.map(b => ({
        range: b._id === '100+' ? '100+' : `${b._id}-${b._id + 20}`,
        count: b.count
      })),
      daily: daily.map(d => ({ date: d._id, total: d.total, hard_block: d.hard_block }))
    });
  } catch (err) {
    return next(err);
  }
};
