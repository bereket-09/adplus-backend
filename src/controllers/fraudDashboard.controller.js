/**
 * fraudDashboard.controller.js — Real fraud observability for the admin UI
 * (no mock data). Reads durable FraudDetection + Blacklist from Mongo and live
 * cardinalities from Redis.
 */
const FraudDetection = require('../models/fraudDetection.model');
const Blacklist = require('../models/blacklist.model');
const store = require('../lib/store');
const k = require('../fraud/keys');
const logger = require('../utils/logger');

function sinceFrom(query) {
  const hours = Math.min(24 * 30, Math.max(1, Number(query.hours) || 24));
  return new Date(Date.now() - hours * 3600 * 1000);
}

/** GET /fraud/overview — KPIs + action/stage/signal breakdown over a window. */
exports.overview = async (req, res, next) => {
  try {
    const since = sinceFrom(req.query);
    const [byAction, byStage, bySignal, totals, autoBl] = await Promise.all([
      FraudDetection.aggregate([{ $match: { created_at: { $gte: since } } }, { $group: { _id: '$action', n: { $sum: 1 } } }]),
      FraudDetection.aggregate([{ $match: { created_at: { $gte: since } } }, { $group: { _id: '$stage', n: { $sum: 1 } } }]),
      FraudDetection.aggregate([
        { $match: { created_at: { $gte: since } } },
        { $unwind: '$reasons' },
        { $group: { _id: '$reasons', n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 15 },
      ]),
      FraudDetection.countDocuments({ created_at: { $gte: since } }),
      Blacklist.aggregate([{ $match: { blocked_by: 'fraud-engine', is_active: true } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]),
    ]);

    const asMap = (arr) => arr.reduce((m, x) => (m[x._id || 'unknown'] = x.n, m), {});
    const actions = asMap(byAction);
    const hardBlocks = (actions.hard_block || 0) + (actions.challenge || 0);
    res.json({
      status: true,
      window_hours: Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24)),
      kpis: {
        total_detections: totals,
        hard_blocks: hardBlocks,
        auto_blacklisted: autoBl.reduce((a, x) => a + x.n, 0),
        anomaly_rate: totals ? Number(((hardBlocks / totals) * 100).toFixed(1)) : 0,
      },
      by_action: actions,
      by_stage: asMap(byStage),
      top_signals: bySignal.map((s) => ({ signal: s._id, count: s.n })),
      auto_blacklist_by_severity: asMap(autoBl),
    });
  } catch (err) { logger.error(`fraudDashboard.overview - ${err.message}`); next(err); }
};

/** GET /fraud/detections — recent detections (keyset paginated by created_at). */
exports.detections = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.stage) filter.stage = req.query.stage;
    if (req.query.source) filter.source = req.query.source;
    if (req.query.cursor) filter.created_at = { $lt: new Date(req.query.cursor) };
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await FraudDetection.find(filter).sort({ created_at: -1 }).limit(limit).lean();
    res.json({ status: true, count: rows.length, next_cursor: rows.length ? rows[rows.length - 1].created_at : null, detections: rows });
  } catch (err) { logger.error(`fraudDashboard.detections - ${err.message}`); next(err); }
};

/** GET /fraud/blacklist-auto — entries the engine created, showing the ladder. */
exports.autoBlacklist = async (req, res, next) => {
  try {
    const rows = await Blacklist.find({ blocked_by: 'fraud-engine', is_active: true })
      .sort({ updated_at: -1 }).limit(200).lean();
    res.json({ status: true, count: rows.length, entries: rows });
  } catch (err) { logger.error(`fraudDashboard.autoBlacklist - ${err.message}`); next(err); }
};

/** GET /fraud/live — live Redis fan-out cardinalities (current SIM-farm pressure). */
exports.live = async (req, res, next) => {
  try {
    const [devIds, ipIds] = await Promise.all([store.setMembers(k.fanDevIndex), store.setMembers(k.fanIpIndex)]);
    const top = async (ids, fanKey) => {
      const scored = [];
      for (const id of ids.slice(0, 500)) scored.push({ id, count: await store.setCard(fanKey(id)) });
      return scored.sort((a, b) => b.count - a.count).slice(0, 20);
    };
    res.json({
      status: true,
      top_devices: await top(devIds, k.fanDev),
      top_ips: await top(ipIds, k.fanIp),
    });
  } catch (err) { logger.error(`fraudDashboard.live - ${err.message}`); next(err); }
};
