const bcrypt = require('bcryptjs');
const WatchLink = require('../models/watchLink.model');
const Meta = require('../utils/meta');
const AuditLog = require('../models/audit.model');
const RewardEngine = require('../utils/rewardEngine');
const budgetLedger = require('../services/budgetLedger');
const rewardGateway = require('../integrations/reward');
const frequency = require('../services/frequency');
const Reward = require('../models/reward.model');
const Ad = require('../models/ad.model');
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
      return res.status(410).json({ status: false, error: 'Link Expired' });
    }

    const metaDecoded = Meta.decodeAndValidate(meta, req);
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

    logger.info(`TrackController.start - User started watching token ${token}`);

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

    const metaDecoded = Meta.decodeAndValidate(meta, req);
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

    // ---- Budget COMMIT + reward fulfilment (idempotent on budget_state) ----
    // Only a link whose budget is still 'reserved' can be committed, so a
    // double-complete or a replay can never deduct twice or reward twice.
    let rewardStatus = watch.reward_status || 'pending';
    let rewardOfferId = watch.reward_offer_id || null;
    let rewardRecordId = watch.reward_record_id || null;

    // Atomically CLAIM the commit: flip budget_state reserved->committing in one
    // conditional update. Two concurrent completes race here and exactly ONE wins
    // (modifiedCount===1), so budget is spent once and the reward granted once
    // (TOCTOU fix). The rewards.token unique index is the belt-and-suspenders guard.
    const claim = await WatchLink.updateOne(
      { _id: watch._id, budget_state: 'reserved' },
      { $set: { budget_state: 'committing' } }
    );

    if (claim.modifiedCount === 1) {
      // 1) Turn the reservation into durable spend (Mongo ledger + wallet).
      await budgetLedger.commit({
        marketerId: watch.marketer_id,
        adId: watch.ad_id,
        amountCents: budgetLedger.toCents(watch.reserved_amount),
        reason: 'Ad watched deduction',
        description: `Completed watch ${watch.token}`,
      });

      // 2) Engagement signal (feeds frequency/eligibility scoring).
      await frequency.recordView(watch.msisdn);

      // 3) Synchronous reward grant to ETC (data/airtime provisioning).
      const ad = await Ad.findById(watch.ad_id).lean();
      rewardOfferId = `OFFER-${watch.token.slice(0, 8).toUpperCase()}`;
      const grant = await rewardGateway.grant({
        msisdn: watch.msisdn,
        ad,
        reward_description: ad ? ad.reward_description : null,
        offer_id: rewardOfferId,
        token: watch.token,
      });
      rewardStatus = grant.status;

      const rewardDoc = await Reward.create({
        msisdn: watch.msisdn,
        token: watch.token,
        ad_id: watch.ad_id,
        offer_id: rewardOfferId,
        status: grant.status === 'granted' ? 'granted' : 'failed',
      });
      rewardRecordId = rewardDoc._id;

      // Finalize atomically (don't clobber via a stale in-memory save()).
      await WatchLink.updateOne({ _id: watch._id }, { $set: {
        budget_state: 'committed',
        reward_granted: grant.ok,
        reward_status: grant.status,
        reward_offer_id: rewardOfferId,
        reward_record_id: rewardRecordId,
        reward_provider_ref: grant.provider_ref || null,
      } });

      if (!grant.ok) {
        logger.warn(`TrackController.complete - reward grant FAILED for ${watch.msisdn} token ${watch.token}: ${grant.error}`);
      }
    } else {
      logger.info(`TrackController.complete - commit already claimed/done for ${watch.token}, skipping double-commit`);
    }

    res.json({
      status: true,
      watch_status: 'completed',
      fraud_flags: watch.fraud_flags,
      reward: rewardStatus === 'granted' ? 'granted' : rewardStatus,
      reward_offer_id: rewardOfferId,
      reward_record_id: rewardRecordId,
      secure_key: newSecureKey // next transport key
    });

  } catch (err) {
    logger.error(`WatchLinkController.complete - ${err.message}`);
    next(err);
  }
};


/**
 * Video progress ping (for drop-off analytics)
 */
exports.ping = async (req, res, next) => {
  try {
    const { token, position, secure_key } = req.body;

    if (!token || position === undefined || !secure_key) {
      return res.status(400).json({ status: false, error: 'token, position, secure_key required' });
    }

    const watch = await WatchLink.findOne({ token });
    if (!watch) return res.status(404).json({ status: false, error: 'token not found' });

    if (watch.secure_key !== secure_key) {
      return res.status(403).json({ status: false, error: 'Invalid secure key' });
    }

    if (watch.status === 'completed') {
      return res.json({ status: true, message: 'Already completed' });
    }

    // Update positions
    watch.last_position = position;
    if (position > (watch.max_position_reached || 0)) {
      watch.max_position_reached = position;
    }

    // Store as drop-off point for now (will be updated on next ping or complete)
    watch.drop_off_point = position;

    await watch.save();

    res.json({
      status: true,
      last_position: watch.last_position,
      max_position: watch.max_position_reached
    });

  } catch (err) {
    logger.error(`WatchLinkController.ping - ${err.message}`);
    next(err);
  }
};

/**
 * Ad Click Tracking
 */
exports.click = async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ status: false, error: 'token required' });

    const watch = await WatchLink.findOne({ token });
    if (!watch) return res.status(404).json({ status: false, error: 'token not found' });

    const ad = await require('../models/ad.model').findById(watch.ad_id);
    if (!ad) return res.status(404).json({ status: false, error: 'Ad not found' });

    // Mark clicked
    watch.clicked = true;
    watch.clicked_at = new Date();
    await watch.save();

    // If billing_model is 'view_and_click', charge the click fee atomically
    // (reserve from the live counter, then commit to durable spend).
    if (ad.billing_model === 'view_and_click' && !watch.clicked_charged) {
      const r = await budgetLedger.reserveClick(ad);
      if (r.ok && r.amountCents > 0) {
        await budgetLedger.commit({
          marketerId: watch.marketer_id,
          adId: ad._id,
          amountCents: r.amountCents,
          reason: 'Ad click deduction',
          description: `Click on ad ${ad._id} (${watch.token})`,
        });
        watch.clicked_charged = true;
        await watch.save();
      }
    }

    res.json({ status: true, message: 'Click recorded' });
  } catch (err) {
    logger.error(`WatchLinkController.click - ${err.message}`);
    next(err);
  }
};

