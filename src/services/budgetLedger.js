/**
 * budgetLedger.js — Two-phase, two-tier campaign budget.
 *
 *   RESERVE  at SMS-send time      (atomic decrement of the live counter)
 *   COMMIT   at watch completion   (durable spend: Mongo ledger + wallet)
 *   RELEASE  when a link expires    (unwatched reservation returns to budget)
 *
 * Tier 1 (hot path): a Redis counter per campaign, in ETB cents. Atomic, shared
 *   across processes, and the single source of truth for "can we afford to send".
 * Tier 2 (durable): MongoDB — `MarketerTransaction` ledger + `ad.remaining_budget`
 *   + marketer wallet, written asynchronously on COMMIT only. Never on the hot path.
 *
 * The Redis counter is lazily seeded from `ad.remaining_budget` the first time a
 * campaign is touched, so approvals/top-ups don't need to prime it (though
 * `resync()` is provided for explicit budget changes).
 */

const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const MarketerTransaction = require('../models/marketerTransaction.model');
const store = require('../lib/store');
const cfg = require('../config/engine');
const logger = require('../utils/logger');

const toCents = (birr) => Math.round(Number(birr || 0) * 100);
const toBirr = (cents) => Number(cents || 0) / 100;
const key = (adId) => `budget:ad:${adId}`;

function viewCostCents(ad) {
  const cpv = ad.cost_per_view != null ? ad.cost_per_view : cfg.budget.defaultCostPerView;
  return toCents(cpv);
}
function clickCostCents(ad) {
  const cpv = ad.cost_per_view != null ? ad.cost_per_view : cfg.budget.defaultCostPerView;
  return toCents(cpv * cfg.budget.clickCostRatio);
}

/**
 * Attempt to reserve one view's worth of budget for `ad`.
 * @returns {Promise<{ok:boolean, reason?:string, amountCents?:number, remainingBirr?:number}>}
 */
async function reserveView(ad) {
  const amount = viewCostCents(ad);
  if (amount <= 0) return { ok: true, amountCents: 0, remainingBirr: toBirr(await store.getCounter(key(ad._id))) };
  const seed = toCents(ad.remaining_budget);
  const res = await store.reserve(key(ad._id), amount, seed);
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, amountCents: amount, remainingBirr: toBirr(res.remaining) };
}

/** Reserve a click fee (view_and_click billing). */
async function reserveClick(ad) {
  const amount = clickCostCents(ad);
  if (amount <= 0) return { ok: true, amountCents: 0 };
  const seed = toCents(ad.remaining_budget);
  const res = await store.reserve(key(ad._id), amount, seed);
  return res.ok ? { ok: true, amountCents: amount } : { ok: false, reason: res.reason };
}

/**
 * Commit a previously-reserved amount to durable spend. Idempotency is the
 * caller's responsibility (guarded by watch link `budget_state`).
 */
async function commit({ marketerId, adId, amountCents, reason = 'Ad watched deduction', description }) {
  const amount = toBirr(amountCents);
  if (amount <= 0) return;

  // Durable ledger + wallet mirror. The Redis counter was already decremented at
  // reserve time, so we do NOT touch it here — commit only persists the truth.
  // Atomic $inc (not read-modify-write) so concurrent commits can't race the wallet.
  const marketer = await Marketer.findOneAndUpdate(
    { _id: marketerId },
    { $inc: { remaining_budget: -amount } },
    { new: true }
  );
  const newWallet = marketer ? marketer.remaining_budget : 0;
  const prevWallet = newWallet + amount;

  // Atomic ad decrement + conditional pause in a single round-trip (no second read,
  // no race): pipeline update subtracts then flips status to paused when depleted.
  const ad = await Ad.findOneAndUpdate(
    { _id: adId },
    [
      { $set: { remaining_budget: { $subtract: ['$remaining_budget', amount] } } },
      { $set: { status: { $cond: [{ $lte: ['$remaining_budget', 0] }, 'paused', '$status'] } } },
    ],
    { new: true }
  );
  if (ad && ad.remaining_budget <= 0) {
    logger.info(`budgetLedger.commit - campaign ${adId} budget depleted, paused`);
  }

  await MarketerTransaction.create({
    marketer_id: marketerId,
    type: 'deduction',
    amount,
    previous_budget: prevWallet,
    new_budget: newWallet,
    reason,
    description: description || `Committed ${amount} ETB for ad ${adId}`,
  });
}

/** Return an unspent reservation to the live counter. */
async function release(adId, amountCents) {
  if (!amountCents || amountCents <= 0) return;
  await store.release(key(adId), amountCents);
  logger.debug(`budgetLedger.release - returned ${toBirr(amountCents)} ETB to campaign ${adId}`);
}

/** Force the live counter to match Mongo (call after top-ups / allocation edits). */
async function resync(adId) {
  const ad = await Ad.findById(adId).select('remaining_budget').lean();
  if (!ad) return;
  await store.setCounter(key(adId), toCents(ad.remaining_budget));
}

/** Live remaining budget (ETB) for a campaign, seeding if needed. */
async function remaining(ad) {
  let cents = await store.getCounter(key(ad._id));
  if (cents == null) { cents = toCents(ad.remaining_budget); await store.setCounter(key(ad._id), cents); }
  return toBirr(cents);
}

module.exports = {
  reserveView, reserveClick, commit, release, resync, remaining,
  viewCostCents, clickCostCents, toBirr, toCents,
};
