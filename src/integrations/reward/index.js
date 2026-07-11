/**
 * Reward fulfilment adapter (swappable).
 *
 * Selected by REWARD_DRIVER (http | mock). On watch completion the system makes a
 * SYNCHRONOUS call to ETC to actually grant the reward (data bundle / airtime).
 * The contract is `grant({ msisdn, ad, reward_description, offer_id, token })`.
 */

const cfg = require('../../config/engine');
const logger = require('../../utils/logger');

let impl;
switch (cfg.reward.driver) {
  case 'http': impl = require('./httpReward'); break;
  case 'mock':
  default: impl = require('./mockReward'); break;
}

logger.info(`reward: driver='${cfg.reward.driver}'`);

/**
 * @returns {Promise<{ok:boolean, provider_ref?:string, status:'granted'|'pending'|'failed', error?:string}>}
 */
async function grant(p) {
  return impl.grant(p);
}

module.exports = { grant, driver: cfg.reward.driver };
