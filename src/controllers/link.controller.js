const { generateToken } = require('../utils/token');
const Meta = require('../utils/meta');
const AdEngine = require('../utils/adEngine');
const WatchLink = require('../models/watchLink.model');
const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const AuditLog = require('../models/audit.model');
const { API_DOMAIN } = process.env;
const bcrypt = require('bcryptjs'); // <-- added for secure key
const logger = require('../utils/logger'); // <-- import logger

exports.createLink = async (req, res, next) => {
  try {
    const { msisdn } = req.body;
    logger.info(`WatchLinkController.createLink - Received request to create link for msisdn ${msisdn}`);

    if (!msisdn) {
      logger.error(`WatchLinkController.createLink - msisdn required`);
      return res.status(400).json({ status: false, error: 'msisdn required' });
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // -------------------------------------------
    // CHECK IF EXISTING ACTIVE TOKEN EXISTS TODAY
    // -------------------------------------------
    const existing = await WatchLink.findOne({
      msisdn,
      status: { $in: ['pending', 'opened', 'started'] },
      created_at: { $gte: startOfDay }
    });

    if (existing) {
      logger.debug(`WatchLinkController.createLink - Existing token ${existing.token} found for msisdn ${msisdn}`);

      // -----------------------------------------------------
      // MOCK SMS TRIGGER (ALWAYS RESEND WHEN LINK REQUESTED)
      // -----------------------------------------------------
      logger.info(`SMS-MOCK: Sending SMS to ${msisdn} with link ${API_DOMAIN}/watch/${existing.token}`);

      await AuditLog.create({
        type: 'sms_sent',
        msisdn,
        token: existing.token,
        ad_id: existing.ad_id,
        marketer_id: existing.marketer_id,
        timestamp: new Date(),
        note: 'SMS resent for existing link'
      });

      return res.json({
        status: true,
        token: existing.token,
        watch_url: `${API_DOMAIN}/watch?v=${existing.token}`,
        state: existing.status,
        secure_key: existing.secure_key,
        createdStatus: "existing"
      });
    }

    // -------------------------------------------
    // NO EXISTING LINK → CREATE NEW ONE
    // -------------------------------------------
    const ad = await AdEngine.selectAd();
    if (!ad) {
      logger.error(`WatchLinkController.createLink - No active ads available`);
      return res.status(400).json({ status: false, error: 'no active ads available' });
    }

    const token = generateToken();

    const watch = new WatchLink({
      token,
      msisdn,
      ad_id: ad._id,
      marketer_id: ad.marketer_id,
      status: 'pending',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 1000 * 60 * 60 * 3) // 3 hours expiry
    });
    await watch.save();

    // -----------------------
    // AUDIT: LINK CREATED
    // -----------------------
    await AuditLog.create({
      type: 'link_created',
      msisdn,
      token,
      ad_id: ad._id,
      marketer_id: ad.marketer_id,
      timestamp: new Date()
    });

    logger.info(`WatchLinkController.createLink - Link created for msisdn ${msisdn}, token ${token}`);

    // -----------------------
    // MOCK SMS TRIGGER
    // -----------------------
    logger.info(`SMS-MOCK: Sending SMS to ${msisdn} with link ${API_DOMAIN}/watch/${token}`);

    // ----------------------------------------
    // AUDIT: SMS SENT FOR NEW LINK
    // ----------------------------------------
    await AuditLog.create({
      type: 'sms_sent',
      msisdn,
      token,
      ad_id: ad._id,
      marketer_id: ad.marketer_id,
      timestamp: new Date(),
      note: 'SMS sent for new link'
    });

    // -----------------------
    // RETURN RESPONSE
    // -----------------------
    return res.json({
      status: true,
      token,
      watch_url: `${API_DOMAIN}/watch?v=${token}`,
      state: watch.status,
      secure_key: watch.secure_key,
      createdStatus: "new"
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

    const meta = Meta.decodeAndValidate(metaBase64);
    if (!meta.valid) {
      await watch.addAudit('opened', false, meta.report);
      logger.error(`WatchLinkController.getVideoByToken - Invalid metadata for token ${token}`);
      return res.status(400).json({ status: false, error: 'invalid Link or user status' });
    }

    if (meta.payload.msisdn !== watch.msisdn) {
      await watch.addFraud('msisdn_mismatch', { expected: watch.msisdn, got: meta.payload.msisdn });
      logger.error(`WatchLinkController.getVideoByToken - msisdn mismatch for token ${token}, expected ${watch.msisdn}, got ${meta.payload.msisdn}`);
      return res.status(403).json({ status: false, error: 'invalid Link or user status' });
    }

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

    const ad = await Ad.findById(watch.ad_id);
    const video_url = (process.env.CDN_DOMAIN || '') + (ad && ad.video_file_path ? ('/' + ad.video_file_path.replace(/^\/+/, '')) : '/ads/default.mp4');

    logger.info(`WatchLinkController.getVideoByToken - Video URL generated for token ${token}, msisdn ${watch.msisdn}`);

    return res.json({ status: true, ad_id: String(watch.ad_id), video_url, token, secure_key: watch.secure_key });
  } catch (err) {
    logger.error(`WatchLinkController.getVideoByToken - Error fetching video: ${err.message}`);
    next(err);
  }
};

