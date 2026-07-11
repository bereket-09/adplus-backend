/**
 * decisionEngine.js — The single place that decides whether to spend an SMS +
 * budget on a subscriber, and on which ad.
 *
 * Pipeline (each step can short-circuit with a reason code):
 *   1. blacklist        — hard block
 *   2. active link      — don't double-reserve for a user who already has a link
 *   3. frequency caps   — daily/weekly SMS, views/day, min-gap
 *   4. selection        — unseen, in-budget, in-schedule ads (no repeats)
 *   5. eligibility score— "is it worth it" (suppresses reward-fishers / seen-all)
 *   6. pace + reserve   — walk ranked ads, take the first that passes pacing AND
 *                          atomically reserves budget
 *   7. dispatch         — create watch link, record frequency, send SMS
 *
 * Every outcome is an object: { action, reason, ... }. `action` is one of
 * 'sent' | 'resent' | 'suppressed' | 'error'. Suppressions are normal, cheap,
 * and logged for observability — most morning triggers get suppressed by design.
 */

const WatchLink = require('../models/watchLink.model');
const AuditLog = require('../models/audit.model');
const { generateToken } = require('../utils/token');
const blacklistCheck = require('../utils/blacklistCheck');
const frequency = require('./frequency');
const adSelector = require('./adSelector');
const eligibility = require('./eligibility');
const pacing = require('./pacing');
const budgetLedger = require('./budgetLedger');
const sms = require('../integrations/sms');
const cfg = require('../config/engine');
const logger = require('../utils/logger');

function watchUrl(token) {
  return `${cfg.sms.watchBaseUrl.replace(/\/$/, '')}/watch?v=${token}`;
}

// Fire-and-forget audit so Mongo writes never sit on the hot path.
function audit(doc) {
  AuditLog.create({ timestamp: new Date(), ...doc }).catch((e) =>
    logger.warn(`decisionEngine.audit - ${e.message}`)
  );
}

async function findActiveLink(msisdn) {
  return WatchLink.findOne({
    msisdn,
    status: { $in: ['pending', 'opened', 'started'] },
    expires_at: { $gt: new Date() },
  }).sort({ created_at: -1 });
}

async function resend(link, ad) {
  const url = watchUrl(link.token);
  const message = sms.renderWatchSms({ url, reward: ad ? ad.reward_description : null });
  const r = await sms.send({ msisdn: link.msisdn, message });
  audit({ type: 'sms_sent', msisdn: link.msisdn, token: link.token, ad_id: link.ad_id, marketer_id: link.marketer_id, note: 'resend', request_payload: { provider_ref: r.provider_ref, ok: r.ok } });
  return { action: 'resent', token: link.token, watch_url: url, sms_ok: r.ok };
}

/**
 * @param {object} input
 * @param {string} input.msisdn
 * @param {string} [input.source='ocs']
 * @param {object} [input.ctx]     { ip, tags }
 * @param {object} [input.options] { allowResend, bypassPacing, bypassFrequency, skipSms, triggeredAtMs }
 */
async function decide(input) {
  const { msisdn } = input;
  const source = input.source || 'ocs';
  const ctx = input.ctx || {};
  const opt = input.options || {};
  const now = Date.now();

  if (!msisdn) return { action: 'error', reason: 'missing_msisdn' };

  // Drop triggers that sat in the queue past their morning relevance.
  if (opt.triggeredAtMs && !opt.bypassPacing) {
    const ageMin = (now - opt.triggeredAtMs) / 60_000;
    if (ageMin > cfg.pacing.candidateStaleMinutes) {
      return { action: 'suppressed', reason: 'stale' };
    }
  }

  // 1) Blacklist
  const bl = await blacklistCheck.checkAll({ msisdn, ip: ctx.ip });
  if (bl.blocked) {
    audit({ type: 'blacklist_blocked', msisdn, ip: ctx.ip, fraud_detected: true, request_payload: { reasons: bl.reasons } });
    return { action: 'suppressed', reason: 'blacklisted' };
  }

  // 2) Existing active link → resend or suppress (never double-reserve)
  const existing = await findActiveLink(msisdn);
  if (existing) {
    if (opt.allowResend) {
      const Ad = require('../models/ad.model');
      const ad = await Ad.findById(existing.ad_id).lean();
      return resend(existing, ad);
    }
    return { action: 'suppressed', reason: 'active_link_exists', token: existing.token };
  }

  // 3) Frequency caps + engagement snapshot
  const state = await frequency.getState(msisdn);
  if (!opt.bypassFrequency) {
    const caps = frequency.checkCaps(state, now);
    if (!caps.ok) return { action: 'suppressed', reason: caps.reason };
  }

  // 4) Candidate selection (unseen, servable)
  const sel = await adSelector.selectForUser(msisdn, state, { tags: ctx.tags });
  if (sel.activeCount === 0) return { action: 'suppressed', reason: 'no_active_ads' };
  if (sel.unseenCount === 0) return { action: 'suppressed', reason: 'seen_all' };

  // 5) Eligibility score
  if (!opt.bypassFrequency) {
    const scored = eligibility.computeScore(state, { unseenCount: sel.unseenCount, activeCount: sel.activeCount });
    if (scored.score < cfg.eligibility.minScore) {
      return { action: 'suppressed', reason: 'low_score', score: scored.score, weak: scored.dominantWeak };
    }
  }

  // 6) Walk ranked ads; take the first that passes pacing AND reserves budget.
  let chosen = null;
  let reservedCents = 0;
  let pacedOut = false;
  let budgetOut = false;
  for (const ad of sel.ranked) {
    if (!opt.bypassPacing) {
      const p = await pacing.tryCampaign(ad);
      if (!p.allowed) { pacedOut = true; continue; }
    }
    const r = await budgetLedger.reserveView(ad);
    if (!r.ok) { budgetOut = true; continue; }
    chosen = ad;
    reservedCents = r.amountCents;
    break;
  }
  if (!chosen) {
    return { action: 'suppressed', reason: budgetOut && !pacedOut ? 'no_budget' : 'paced' };
  }

  // 7) Dispatch — create the reservation-backed watch link.
  const token = generateToken();
  let link;
  try {
    link = await WatchLink.create({
      token,
      msisdn,
      ad_id: chosen._id,
      marketer_id: chosen.marketer_id,
      status: 'pending',
      created_at: new Date(),
      expires_at: new Date(now + cfg.watchLink.validityMinutes * 60_000),
      purge_at: new Date(now + cfg.watchLink.purgeAfterDays * 86_400_000),
      reserved_amount: budgetLedger.toBirr(reservedCents),
      budget_state: 'reserved',
      trigger_source: source,
    });
  } catch (err) {
    // Couldn't persist the link — undo the reservation so budget isn't leaked.
    await budgetLedger.release(chosen._id, reservedCents);
    logger.error(`decisionEngine.decide - link create failed, released reservation: ${err.message}`);
    return { action: 'error', reason: 'link_persist_failed' };
  }

  audit({ type: 'link_created', msisdn, token, ad_id: chosen._id, marketer_id: chosen.marketer_id, request_payload: { source } });

  // Send SMS (unless caller opted out, e.g. simulator that only wants the URL).
  let smsOk = true;
  if (!opt.skipSms) {
    const url = watchUrl(token);
    const message = sms.renderWatchSms({ url, reward: chosen.reward_description });
    const r = await sms.send({ msisdn, message });
    smsOk = r.ok;
    if (!r.ok) {
      // Hard failure: release budget + void the link so we don't hold spend for
      // an SMS that never left. Frequency is NOT counted (no send happened).
      await budgetLedger.release(chosen._id, reservedCents);
      await WatchLink.updateOne({ _id: link._id }, { status: 'expired', budget_state: 'released' });
      audit({ type: 'sms_failed', msisdn, token, ad_id: chosen._id, marketer_id: chosen.marketer_id, request_payload: { error: r.error } });
      return { action: 'error', reason: 'sms_failed' };
    }
    audit({ type: 'sms_sent', msisdn, token, ad_id: chosen._id, marketer_id: chosen.marketer_id, request_payload: { provider_ref: r.provider_ref } });
  }

  // Count the send only once it truly went out.
  await frequency.recordSend(msisdn, chosen._id, now);

  return {
    action: 'sent',
    token,
    watch_url: watchUrl(token),
    ad_id: String(chosen._id),
    reward: chosen.reward_description,
    reserved: budgetLedger.toBirr(reservedCents),
    sms_ok: smsOk,
  };
}

module.exports = { decide, watchUrl };
