/**
 * SMS gateway adapter (swappable).
 *
 * Selected by SMS_DRIVER (http | mock). The rest of the system only knows the
 * `send({ msisdn, message })` contract, so switching providers — or moving to
 * SMPP later — is a new file here, not a change anywhere else.
 */

const cfg = require('../../config/engine');
const logger = require('../../utils/logger');

let impl;
switch (cfg.sms.driver) {
  case 'http': impl = require('./httpSms'); break;
  case 'mock':
  default: impl = require('./mockSms'); break;
}

logger.info(`sms: driver='${cfg.sms.driver}'`);

/**
 * @param {{msisdn:string, message:string}} p
 * @returns {Promise<{ok:boolean, provider_ref?:string, error?:string}>}
 */
async function send(p) {
  return impl.send(p);
}

/** Render the SMS body for a watch link. */
function renderWatchSms({ url, reward }) {
  return cfg.sms.template
    .replace('{url}', url)
    .replace('{reward}', reward || 'a reward')
    .replace('{validity}', String(Math.round(cfg.watchLink.validityMinutes / 60)));
}

module.exports = { send, renderWatchSms, driver: cfg.sms.driver };
