/**
 * decisionWorker.js — Drains the trigger queue at a paced rate and runs each
 * candidate through the decision engine.
 *
 * The worker's throughput is gated by the GLOBAL SMS-gateway token bucket (via
 * pacing.acquireGateway). Per-campaign pacing + budget happen inside the engine.
 * Outcomes are tallied for the /health and admin observability endpoints.
 */

const triggerQueue = require('../services/triggerQueue');
const decisionEngine = require('../services/decisionEngine');
const pacing = require('../services/pacing');
const logger = require('../utils/logger');

const stats = { processed: 0, sent: 0, suppressed: 0, error: 0, byReason: {} };

// Await a global-gateway token before each dispatch so we never exceed the SMS
// gateway's rate. Sleeps (does not drop) when ahead of pace — the queue buffers.
async function gate() {
  // Loop until a token frees up; cap the wait so a wedged bucket can't hang us.
  for (let i = 0; i < 50; i++) {
    const { allowed, waitMs } = await pacing.acquireGateway();
    if (allowed) return;
    await new Promise((r) => setTimeout(r, Math.min(waitMs || 20, 1000)));
  }
}

async function handle(candidate) {
  stats.processed++;
  try {
    const res = await decisionEngine.decide({
      msisdn: candidate.msisdn,
      source: candidate.source || 'ocs',
      ctx: { ip: candidate.ip, tags: candidate.tags },
      options: { triggeredAtMs: candidate.ts },
    });
    if (res.action === 'sent' || res.action === 'resent') stats.sent++;
    else if (res.action === 'suppressed') stats.suppressed++;
    else stats.error++;
    const reason = res.reason || res.action;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
  } catch (err) {
    stats.error++;
    logger.error(`decisionWorker.handle - ${err.message}`);
  }
}

async function start() {
  await triggerQueue.startConsumers(handle, gate);
  logger.info('decisionWorker: started');
}

function getStats() { return { ...stats }; }

module.exports = { start, getStats };
