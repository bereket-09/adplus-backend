const bcrypt = require('bcryptjs');
const WatchLink = require('../models/watchLink.model');
const Meta = require('../utils/meta');
const AuditLog = require('../models/audit.model');
const RewardEngine = require('../utils/rewardEngine');
const logger = require('../utils/logger'); // <-- add logger

/**
 * Core function to update a watch session for started/completed
 * Adds basic fraud/bot mock logic and updates status.
 */
async function updateWatchSession(watch, metaDecoded, nextStatus, timeField, regenerateKey = false) {
  const fraudFlags = [];

  if (metaDecoded.payload.ip !== watch.meta_json?.ip && watch.meta_json) fraudFlags.push('IP_MISMATCH');
  if (metaDecoded.payload.deviceInfo?.model !== watch.meta_json?.deviceInfo?.model && watch.meta_json) fraudFlags.push('DEVICE_CHANGE');
  if (metaDecoded.payload.userAgent !== watch.meta_json?.userAgent && watch.meta_json) fraudFlags.push('USER_AGENT_CHANGE');

  watch.fraud_flags = fraudFlags;
  watch.meta_json = metaDecoded.payload;

  // Update timestamp + state
  watch[timeField] = new Date();
  watch.status = nextStatus;

  // Regenerate security key for next phase
  let newSecureKey = null;
  if (regenerateKey) {
    const salt = await bcrypt.genSalt(10);
    newSecureKey = await bcrypt.hash(`${watch._id}-${Date.now()}`, salt);
    watch.secure_key = newSecureKey;
  }

  await watch.save();

  // Audit Log
  await AuditLog.create({
    type: nextStatus,
    msisdn: watch.msisdn,
    token: watch.token,
    ad_id: watch.ad_id,
    marketer_id: watch.marketer_id,
    timestamp: new Date(),
    ip: metaDecoded.payload.ip,
    user_agent: metaDecoded.payload.userAgent,
    device_info: metaDecoded.payload.deviceInfo,
    location: metaDecoded.payload.location,
    request_payload: metaDecoded.payload,
    fraud_detected: fraudFlags.length > 0
  });

  return { watch, newSecureKey };
}

/**
 * Video start tracking
 */
exports.start = async (req, res, next) => {
  try {
    const { token, meta, secure_key } = req.body;

    if (!token || !meta || !secure_key) {
      return res.status(400).json({ status: false, error: 'token, meta, secure_key required' });
    }

    const watch = await WatchLink.findOne({ token });
    if (!watch) return res.status(404).json({ status: false, error: 'token not found' });

    if (watch.secure_key !== secure_key) {
      return res.status(403).json({ status: false, error: 'Invalid secure key' });
    }

    if (!['pending', 'opened'].includes(watch.status)) {
      return res.status(403).json({
        status: false,
        error: `Cannot start when status is '${watch.status}'`
      });
    }

    if (watch.expires_at < new Date()) {
      return res.status(410).json({ status: false, error: 'token expired' });
    }

    const metaDecoded = Meta.decodeAndValidate(meta);
    if (!metaDecoded.valid) {
      return res.status(400).json({ status: false, error: 'invalid metadata' });
    }

    const { newSecureKey } = await updateWatchSession(
      watch,
      metaDecoded,
      'started',
      'started_at',
      true // regenerate secure key
    );

    res.json({
      status: true,
      watch_status: 'started',
      fraud_flags: watch.fraud_flags,
      secure_key: newSecureKey
    });

  } catch (err) {
    logger.error(`WatchLinkController.start - ${err.message}`);
    next(err);
  }
};


/**
 * Video complete tracking + reward
 */
exports.complete = async (req, res, next) => {
  try {
    const { token, meta, secure_key } = req.body;

    if (!token || !meta || !secure_key) {
      return res.status(400).json({ status: false, error: 'token, meta, secure_key required' });
    }

    const watch = await WatchLink.findOne({ token });
    if (!watch) return res.status(404).json({ status: false, error: 'token not found' });

    if (watch.secure_key !== secure_key) {
      return res.status(403).json({ status: false, error: 'Invalid secure key' });
    }

    if (watch.status !== 'started') {
      await AuditLog.create({
        type: 'fraud_attempt_completion_without_start',
        msisdn: watch.msisdn,
        token: watch.token,
        ad_id: watch.ad_id,
        marketer_id: watch.marketer_id,
        timestamp: new Date(),
        fraud_detected: true,
        request_payload: meta
      });

      return res.status(403).json({
        status: false,
        error: `Cannot complete video in '${watch.status}' state`
      });
    }

    const metaDecoded = Meta.decodeAndValidate(meta);
    if (!metaDecoded.valid) {
      return res.status(400).json({ status: false, error: 'invalid metadata' });
    }

    const { newSecureKey } = await updateWatchSession(
      watch,
      metaDecoded,
      'completed',
      'completed_at',
      true // regenerate secure key after complete
    );

    const marketer = await RewardEngine.deductBudget(watch.marketer_id, watch.ad_id);
    const reward = await RewardEngine.grantReward(watch.msisdn, watch.token);

    watch.reward_granted = reward.granted;
    watch.reward_offer_id = reward.offer_id;
    watch.reward_record_id = reward.reward_id;
    watch.save();

    res.json({
      status: true,
      watch_status: 'completed',
      fraud_flags: watch.fraud_flags,
      reward: reward.granted ? 'granted' : 'not_granted',
      reward_offer_id: reward.offer_id,
      reward_record_id: reward.reward_id,
      secure_key: newSecureKey // next transport key
    });

  } catch (err) {
    logger.error(`WatchLinkController.complete - ${err.message}`);
    next(err);
  }
};

