/**
 * msisdn.js — Ethiopian MSISDN normalisation + human-readable suppression reasons.
 */

/** Normalise to 2519######## / 2517########. Returns null if implausible. */
function normalizeMsisdn(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('251')) { /* already MSISDN */ }
  else if (s.startsWith('0') && s.length === 10) s = '251' + s.slice(1);
  else if (s.length === 9 && (s.startsWith('9') || s.startsWith('7'))) s = '251' + s;
  else return null;
  return /^251(9|7)\d{8}$/.test(s) ? s : null;
}

const REASON_TEXT = {
  blacklisted: 'Subscriber or IP is blacklisted',
  active_link_exists: 'An active offer already exists for this subscriber',
  cap_sms_day: 'Daily SMS limit reached for this subscriber',
  cap_sms_week: 'Weekly SMS limit reached for this subscriber',
  cap_views_day: 'Daily view limit reached for this subscriber',
  min_gap: 'Too soon since the last offer to this subscriber',
  no_active_ads: 'No active campaigns are available',
  seen_all: 'Subscriber has already seen every eligible ad',
  low_score: 'Subscriber not eligible right now (engagement/frequency)',
  no_budget: 'No campaign has budget available',
  paced: 'All eligible campaigns are ahead of pacing right now',
  stale: 'Trigger expired before it could be served',
  sms_failed: 'SMS gateway rejected the message',
  missing_msisdn: 'MSISDN is required',
  invalid_msisdn: 'MSISDN is not a valid Ethiopian number',
};

function humanReason(reason) {
  return REASON_TEXT[reason] || reason || 'Not sent';
}

module.exports = { normalizeMsisdn, humanReason, REASON_TEXT };
