/**
 * trigger.controller.js — OCS-facing ingestion.
 *
 * The OCS calls this the moment a subscriber's data depreciates. We do the
 * absolute minimum here: authenticate, normalise the MSISDN(s), enqueue, and
 * return 202 immediately. ALL decision logic (budget, pacing, frequency,
 * selection, SMS) happens asynchronously in the decision workers, so a 500k
 * morning burst can't block the OCS or overrun the SMS gateway.
 *
 * Transport is HTTP today; to move to Kafka/RabbitMQ later, point a consumer at
 * triggerQueue.enqueue() — nothing else changes.
 */

const triggerQueue = require('../services/triggerQueue');
const decisionWorker = require('../workers/decisionWorker');
const cfg = require('../config/engine');
const logger = require('../utils/logger');
const { normalizeMsisdn } = require('../utils/msisdn');

function authOk(req) {
  // Fail CLOSED in production: an unset key must never leave the SMS/budget-
  // spending trigger endpoint open to the internet. Only dev may run keyless.
  if (!cfg.ocs.triggerKey) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('trigger.authOk - OCS_TRIGGER_KEY not set in production; rejecting');
      return false;
    }
    return true;
  }
  return req.headers['x-ocs-key'] === cfg.ocs.triggerKey;
}

function extractIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
}

/** POST /api/v1/trigger  — accepts { msisdn } | { msisdns:[] } | { triggers:[{msisdn,tags}] } */
exports.ingest = async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ status: false, error: 'unauthorized' });

  const body = req.body || {};
  let items = [];
  if (Array.isArray(body.triggers)) items = body.triggers;
  else if (Array.isArray(body.msisdns)) items = body.msisdns.map((m) => ({ msisdn: m }));
  else if (body.msisdn) items = [{ msisdn: body.msisdn, tags: body.tags }];

  if (!items.length) return res.status(400).json({ status: false, error: 'no msisdn(s) provided' });

  const ip = extractIp(req);
  const ts = Date.now();
  const candidates = [];
  let rejected = 0;
  for (const it of items) {
    const msisdn = normalizeMsisdn(it.msisdn);
    if (!msisdn) { rejected++; continue; }
    candidates.push({ msisdn, source: 'ocs', ip, ts, tags: it.tags });
  }

  if (!candidates.length) return res.status(400).json({ status: false, error: 'no valid msisdn(s)', rejected });

  await triggerQueue.enqueueBatch(candidates);
  logger.info(`trigger.ingest - accepted=${candidates.length} rejected=${rejected}`);
  return res.status(202).json({ status: true, accepted: candidates.length, rejected });
};

/** GET /api/v1/trigger/stats — worker + queue observability (admin). */
exports.stats = async (req, res) => {
  const depth = await triggerQueue.depth();
  res.json({
    status: true,
    queue_driver: triggerQueue.driver(),
    queue_depth: depth,
    worker: decisionWorker.getStats(),
  });
};
