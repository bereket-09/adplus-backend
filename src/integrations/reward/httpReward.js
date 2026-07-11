/**
 * httpReward.js — Synchronous reward-grant call to ETC/OCS.
 *
 * Configure via env:
 *   REWARD_HTTP_URL  POST endpoint that provisions the reward (data/airtime)
 *   REWARD_API_KEY   auth key
 *
 * Adjust `buildPayload` / response parsing to ETC's provisioning API when its
 * spec is available. Treated as authoritative: a non-ok response means the
 * subscriber was NOT rewarded, and the caller records status accordingly.
 */

const axios = require('axios');
const cfg = require('../../config/engine');
const logger = require('../../utils/logger');

function buildPayload({ msisdn, ad, reward_description, offer_id, token }) {
  return {
    msisdn,
    offer_id,
    token,
    reward: reward_description || ad?.reward_description || null,
    campaign_id: ad?._id ? String(ad._id) : undefined,
    campaign_name: ad?.campaign_name,
  };
}

async function grant(p) {
  if (!cfg.reward.httpUrl) return { ok: false, status: 'failed', error: 'REWARD_HTTP_URL not configured' };
  try {
    const res = await axios.post(cfg.reward.httpUrl, buildPayload(p), {
      timeout: cfg.reward.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': cfg.reward.apiKey ? `Bearer ${cfg.reward.apiKey}` : undefined,
        'x-api-key': cfg.reward.apiKey || undefined,
      },
    });
    const ref = res.data?.transaction_id || res.data?.reference || res.data?.id || null;
    const granted = res.data?.status ? String(res.data.status).toLowerCase() === 'success' : true;
    return { ok: granted, status: granted ? 'granted' : 'failed', provider_ref: ref };
  } catch (err) {
    const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
    logger.error(`httpReward.grant - failed for ${p.msisdn}: ${detail}`);
    return { ok: false, status: 'failed', error: detail };
  }
}

module.exports = { grant };
