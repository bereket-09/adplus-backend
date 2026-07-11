/**
 * mockSms.js — Logs instead of sending. Default when SMS_HTTP_URL is unset so the
 * platform runs end-to-end in dev without a live gateway.
 */

const logger = require('../../utils/logger');

async function send({ msisdn, message }) {
  logger.info(`SMS-MOCK -> ${msisdn}: ${message}`);
  return { ok: true, provider_ref: `mock-${Date.now()}` };
}

module.exports = { send };
