/**
 * frequency.js — Per-subscriber frequency capping, ad rotation memory, and
 * engagement history. All state lives in the shared store (Redis in prod) so it
 * survives restarts and is consistent across every worker.
 *
 * Windows are rolling (24h / 7d) for simplicity; swap the TTLs for calendar-day
 * boundaries if ETC requires strict daily resets.
 */

const store = require('../lib/store');
const cfg = require('../config/engine');

const DAY = 24 * 3600;
const WEEK = 7 * DAY;
const ENG_TTL = 30 * DAY;

const k = {
  smsDay: (m) => `freq:sms:day:${m}`,
  smsWeek: (m) => `freq:sms:week:${m}`,
  viewsDay: (m) => `freq:views:day:${m}`,
  last: (m) => `freq:last:${m}`,
  seen: (m) => `seen:${m}`,
  engSent: (m) => `eng:sent:${m}`,
  engDone: (m) => `eng:done:${m}`,
};

/** Snapshot everything the eligibility scorer needs, in one shot. */
async function getState(msisdn) {
  const [smsDay, smsWeek, viewsDay, lastRaw, seen, sent, done] = await Promise.all([
    store.getInt(k.smsDay(msisdn)),
    store.getInt(k.smsWeek(msisdn)),
    store.getInt(k.viewsDay(msisdn)),
    store.getString(k.last(msisdn)),
    store.setMembers(k.seen(msisdn)),
    store.getInt(k.engSent(msisdn)),
    store.getInt(k.engDone(msisdn)),
  ]);
  return {
    smsDay, smsWeek, viewsDay,
    lastSmsMs: lastRaw ? Number(lastRaw) : 0,
    seen: new Set((seen || []).map(String)),
    sent, done,
  };
}

/**
 * Hard caps check — returns { ok, reason } BEFORE any scoring. These are absolute
 * limits; the scorer handles the softer "is it worth it" judgement.
 */
function checkCaps(state, nowMs) {
  const f = cfg.frequency;
  if (state.smsDay >= f.maxSmsPerDay) return { ok: false, reason: 'cap_sms_day' };
  if (state.smsWeek >= f.maxSmsPerWeek) return { ok: false, reason: 'cap_sms_week' };
  if (state.viewsDay >= f.maxViewsPerDay) return { ok: false, reason: 'cap_views_day' };
  if (state.lastSmsMs && nowMs - state.lastSmsMs < f.minGapMinutes * 60_000) {
    return { ok: false, reason: 'min_gap' };
  }
  return { ok: true };
}

/** Record that an SMS was dispatched (reserve + send succeeded). */
async function recordSend(msisdn, adId, nowMs) {
  await Promise.all([
    store.incrWithTtl(k.smsDay(msisdn), DAY),
    store.incrWithTtl(k.smsWeek(msisdn), WEEK),
    store.setString(k.last(msisdn), String(nowMs), WEEK),
    store.setAdd(k.seen(msisdn), String(adId), cfg.frequency.seenWindowDays * DAY),
    store.incrWithTtl(k.engSent(msisdn), ENG_TTL),
  ]);
}

/** Record that the subscriber actually completed a watch (for engagement scoring). */
async function recordView(msisdn) {
  await Promise.all([
    store.incrWithTtl(k.viewsDay(msisdn), DAY),
    store.incrWithTtl(k.engDone(msisdn), ENG_TTL),
  ]);
}

module.exports = { getState, checkCaps, recordSend, recordView, keys: k };
