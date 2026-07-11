/**
 * mockReward.js — Pretends the grant succeeded. Default when REWARD_HTTP_URL is
 * unset so completion + reward flows work end-to-end in dev.
 */

const logger = require('../../utils/logger');

async function grant({ msisdn, reward_description, offer_id }) {
  logger.info(`REWARD-MOCK -> ${msisdn}: granted '${reward_description || 'reward'}' (offer ${offer_id})`);
  return { ok: true, status: 'granted', provider_ref: `mock-${Date.now()}` };
}

module.exports = { grant };
