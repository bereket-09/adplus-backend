const { generateToken } = require('../utils/token');
const Meta = require('../utils/meta');
const AdEngine = require('../utils/adEngine');
const WatchLink = require('../models/watchLink.model');
const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const AuditLog = require('../models/audit.model');
const { API_DOMAIN } = process.env;
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const blacklistCheck = require('../utils/blacklistCheck');
const cache = require('../utils/internalCache');
const DecisionEngine = require('../services/decisionEngine');
const fraudEngine = require('../fraud/fraudEngine');
const fingerprint = require('../fraud/fingerprint');
const { normalizeMsisdn, humanReason } = require('../utils/msisdn');

/**
 * Manual / simulator link creation. Delegates to the unified DecisionEngine so it
 * shares the exact budget-reservation, frequency, selection and SMS logic used by
 * the OCS pipeline — no divergent code path. Pacing is bypassed (this is an
 * on-demand action, not a paced OCS burst); pass `force:true` to also bypass
 * frequency caps for repeat testing.
 */
exports.createLink = async (req, res, next) => {
  try {
    const { msisdn: rawMsisdn, tags, force } = req.body;
    logger.info(`WatchLinkController.createLink - Received request for msisdn ${rawMsisdn}`);

    if (!rawMsisdn) {
      return res.status(400).json({ status: false, error: 'msisdn required' });
    }
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) {
      return res.status(400).json({ status: false, error: 'invalid Ethiopian MSISDN', reason: 'invalid_msisdn' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
    const result = await DecisionEngine.decide({
      msisdn,
      source: 'simulator',
      ctx: { ip, tags },
      options: { allowResend: true, bypassPacing: true, bypassFrequency: !!force },
    });

    if (result.action === 'sent' || result.action === 'resent') {
      return res.json({
        status: true,
        token: result.token,
        watch_url: result.watch_url,
        state: 'pending',
        reward: result.reward,
        sms_ok: result.sms_ok,
        createdStatus: result.action === 'resent' ? 'existing' : 'new',
      });
    }

    // Suppressed (normal) or error — surface the reason for the simulator UI.
    const code = result.reason === 'no_active_ads' ? 400 : 200;
    return res.status(code).json({
      status: false,
      suppressed: result.action === 'suppressed',
      reason: result.reason,
      error: humanReason(result.reason),
    });
  } catch (err) {
    logger.error(`WatchLinkController.createLink - Error creating link: ${err.message}`);
    next(err);
  }
};



exports.getVideoByToken = async (req, res, next) => {
  try {
    const token = req.params.token;
    const metaBase64 = req.headers['meta_base64'] || req.query.meta_base64 || req.body.meta_base64;

    logger.info(`WatchLinkController.getVideoByToken - Fetch video request for token ${token}`);

    if (!metaBase64) {
      logger.error(`WatchLinkController.getVideoByToken - meta_base64 required`);
      return res.status(400).json({ status: false, error: 'invalid Link or user status' });
    }

    const watch = await WatchLink.findOne({ token });
    if (!watch) {
      logger.error(`WatchLinkController.getVideoByToken - Invalid token ${token}`);
      return res.status(404).json({ status: false, error: 'invalid Link or user status' });
    }

    if (watch.status === 'completed' || watch.expires_at < new Date()) {
      logger.debug(`WatchLinkController.getVideoByToken - Token ${token} expired or completed`);
      return res.status(410).json({ status: false, error: 'Shared Link expired or May have been Already Completed' });
    }

    // The token already identifies the subscriber, so we don't require the client
    // to supply an MSISDN here — we hand back the authoritative one below.
    const meta = Meta.decodeAndValidate(metaBase64, req, { requireMsisdn: false });
    if (!meta.valid) {
      // await watch.addAudit('opened', false, meta.report);
      logger.error(`WatchLinkController.getVideoByToken - Invalid metadata for token ${token}: ${meta.report}`);
      return res.status(400).json({ status: false, error: `Invalid security context: ${meta.report}` });
    }

    // if (meta.payload.msisdn !== watch.msisdn) {
    //   await watch.addFraud('msisdn_mismatch', { expected: watch.msisdn, got: meta.payload.msisdn });
    //   logger.error(`WatchLinkController.getVideoByToken - msisdn mismatch for token ${token}, expected ${watch.msisdn}, got ${meta.payload.msisdn}`);
    //   return res.status(403).json({ status: false, error: 'invalid Link or user status' });
    // }

    // Fraud gate at video open — first point a real device fingerprint exists,
    // so this seeds the SIM-farm fan-out sets. Fail-open.
    const fSubject = fingerprint.buildSubject(meta.payload, { msisdn: watch.msisdn, token, watch });
    const fraud = await fraudEngine.evaluate('open', fSubject);
    if (fraud.decision === 'deny') {
      logger.warn(`getVideoByToken - fraud denied token ${token} score=${fraud.score} [${fraud.reasons}]`);
      return res.status(403).json({ status: false, error: 'link unavailable' });
    }
    if (fraud.action !== 'allow') watch.has_fraud = true;

    const ip = meta.payload.ip || req.ip;
    const ua = meta.payload.userAgent || '';

    const changed = watch.detectChange({ ip, userAgent: ua, location: meta.payload.location });
    if (changed) {
      await watch.addFraud('device_change', { ip, userAgent: ua });
      logger.info(`WatchLinkController.getVideoByToken - Device or IP changed for token ${token}`);
      // return res.status(403).json({ status: false, error: 'device or ip changed; rewatch required' });
    }

    // --- Secure Key Generation ---
    if (!watch.secure_key) {
      const salt = await bcrypt.genSalt(10);
      watch.secure_key = await bcrypt.hash(`${watch._id}-${Date.now()}`, salt);
      logger.info(`WatchLinkController.getVideoByToken - Secure key generated for token ${token}`);
    }

    watch.status = 'opened';
    watch.opened_at = new Date();
    watch.ip = ip;
    watch.user_agent = ua;
    watch.device_info = meta.payload.deviceInfo || {};
    watch.location = meta.payload.location || null;
    watch.meta_json = meta.payload;
    await watch.save();

    await AuditLog.create({
      type: 'opened',
      msisdn: watch.msisdn,
      token: watch.token,
      ad_id: watch.ad_id,
      marketer_id: watch.marketer_id,
      timestamp: new Date(),
      ip, user_agent: ua, request_payload: meta.payload
    });

    // Cached ad lookup for high TPS
    const adCacheKey = `ad:${watch.ad_id}`;
    let ad = cache.get(adCacheKey);
    if (!ad) {
      ad = await Ad.findById(watch.ad_id).lean();
      if (ad) cache.set(adCacheKey, ad, 60_000); // 1 min cache
    }
    const video_url = (ad && ad.video_file_path) ? ad.video_file_path : '';

    logger.info(`WatchLinkController.getVideoByToken - Video URL generated for token ${token}, msisdn ${watch.msisdn}`);

    return res.json({
        status: true,
        ad_id: String(watch.ad_id),
        video_url,
        token,
        secure_key: watch.secure_key,
        msisdn: watch.msisdn, // authoritative subscriber id (their own number) for meta
        ad // Return the full ad object
    });
  } catch (err) {
    logger.error(`WatchLinkController.getVideoByToken - Error fetching video: ${err.message}`);
    next(err);
  }
};

