/**
 * httpSms.js — Generic HTTP SMS gateway client.
 *
 * Configure via env:
 *   SMS_HTTP_URL   POST endpoint
 *   SMS_API_KEY    bearer/api key (sent as Authorization + x-api-key)
 *   SMS_SENDER_ID  sender id / short code
 *
 * The payload shape below is the common denominator; adjust `buildPayload` to
 * match ETC's actual gateway when its spec is available.
 */

const axios = require('axios');
const cfg = require('../../config/engine');
const logger = require('../../utils/logger');

function buildPayload({ msisdn, message }) {
  return {
    to: msisdn,
    from: cfg.sms.senderId,
    sender_id: cfg.sms.senderId,
    text: message,
    message,
  };
}

async function send({ msisdn, message }) {
  if (!cfg.sms.httpUrl) return { ok: false, error: 'SMS_HTTP_URL not configured' };
  try {
    const res = await axios.post(cfg.sms.httpUrl, buildPayload({ msisdn, message }), {
      timeout: cfg.sms.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': cfg.sms.apiKey ? `Bearer ${cfg.sms.apiKey}` : undefined,
        'x-api-key': cfg.sms.apiKey || undefined,
      },
    });
    const ref = res.data?.message_id || res.data?.id || res.data?.reference || null;
    return { ok: true, provider_ref: ref };
  } catch (err) {
    const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
    logger.error(`httpSms.send - failed for ${msisdn}: ${detail}`);
    return { ok: false, error: detail };
  }
}

module.exports = { send };
