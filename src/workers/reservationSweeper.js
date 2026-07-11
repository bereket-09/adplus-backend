/**
 * reservationSweeper.js — Returns budget from reservations that were never
 * completed.
 *
 * When a subscriber gets an SMS we RESERVE budget. If they never watch, the link
 * expires; this sweeper finds those expired-but-still-reserved links and RELEASES
 * the held budget back to the live counter, so unwatched offers don't
 * permanently burn a campaign's budget.
 *
 * Runs in every process but claims each link atomically (findOneAndUpdate flips
 * budget_state reserved->released), so concurrent sweepers can't double-release.
 */

const WatchLink = require('../models/watchLink.model');
const budgetLedger = require('../services/budgetLedger');
const logger = require('../utils/logger');

const INTERVAL_MS = 60_000;
let timer = null;

async function sweepOnce(limit = 500) {
  let released = 0;
  for (let i = 0; i < limit; i++) {
    const link = await WatchLink.findOneAndUpdate(
      { budget_state: 'reserved', status: { $ne: 'completed' }, expires_at: { $lt: new Date() } },
      { $set: { budget_state: 'released', status: 'expired' } },
      { new: false }
    );
    if (!link) break;
    await budgetLedger.release(link.ad_id, budgetLedger.toCents(link.reserved_amount));
    released++;
  }
  if (released) logger.info(`reservationSweeper: released ${released} expired reservation(s)`);
  return released;
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    sweepOnce().catch((e) => logger.error(`reservationSweeper - ${e.message}`));
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info('reservationSweeper: started');
}

module.exports = { start, sweepOnce };
