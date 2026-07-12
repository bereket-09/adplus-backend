const express = require('express');
const router = express.Router();

const linkRoutes = require('./link.routes');
const trackRoutes = require('./track.routes');
const marketerRoutes = require('./marketer.routes');
const adRoutes = require('./ad.routes');
const analyticsRoutes = require('./analytics.routes');
const budgetRoutes = require('./budget.routes');
const marketerAuthRoutes = require('./auth.marketer.routes');
const adminAuthRoutes = require('./auth.admin.routes');
const systemConfigRoutes = require('./systemConfig.routes');
const blacklistRoutes = require('./blacklist.routes');
const billingModelRoutes = require('./billingModel.routes');
const triggerRoutes = require('./trigger.routes');
const fraudRoutes = require('./fraud.routes');

const rateLimiter = require('../../utils/rateLimiter');
const { checkMaintenanceMode } = require('../../middleware/maintenance.middleware');

// Public routes (not affected by maintenance mode check internally)
router.use('/auth/admin', rateLimiter.middleware(20, 60_000, 'auth-admin'), adminAuthRoutes);
router.use("/auth/marketer", rateLimiter.middleware(20, 60_000, 'auth'), marketerAuthRoutes);
router.get('/maintenance-status', require('../../controllers/systemConfig.controller').getMaintenanceStatus);

// Apply maintenance mode to ALL other routes
router.use(checkMaintenanceMode);

// Apply rate limiting to high-traffic endpoints
router.use('/link', rateLimiter.middleware(200, 60_000, 'link'), linkRoutes);
router.use('/video', rateLimiter.middleware(200, 60_000, 'video'), linkRoutes); // token route uses link controller
router.use('/track', rateLimiter.middleware(300, 60_000, 'track'), trackRoutes);
router.use('/ad', adRoutes);

// OCS trigger ingestion (authenticated by x-ocs-key inside the controller).
// High limit — this is the morning-burst entry point; it only enqueues.
router.use('/trigger', rateLimiter.middleware(20_000, 60_000, 'trigger'), triggerRoutes);

// Health check endpoint (Public)
router.get('/health', async (req, res) => {
    const decisionWorker = require('../../workers/decisionWorker');
    const triggerQueue = require('../../services/triggerQueue');
    const redis = require('../../lib/redis');
    let queueDepth = -1;
    try { queueDepth = await triggerQueue.depth(); } catch (e) { /* ignore */ }
    res.json({
        status: true,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        redis: redis.enabled ? 'connected' : (redis.isConfigured() ? 'configured' : 'in-memory-fallback'),
        queue: { driver: triggerQueue.driver(), depth: queueDepth },
        worker: decisionWorker.getStats()
    });
});

// ==========================================
// PROTECTED ROUTES (Requires JWT Token)
// ==========================================
const { verifyToken } = require('../../middleware/auth.middleware');
router.use(verifyToken);

// Apply maintenance mode (now req.user is populated!)
router.use(checkMaintenanceMode);

// Protected module routes
router.use('/marketer', rateLimiter.middleware(500, 60_000, 'marketer'), marketerRoutes);
router.use('/analytics', rateLimiter.middleware(1000, 60_000, 'analytics'), analyticsRoutes);
router.use('/budget', rateLimiter.middleware(500, 60_000, 'budget'), budgetRoutes);
router.use('/system-config', rateLimiter.middleware(100, 60_000, 'system'), systemConfigRoutes);
router.use('/blacklist', rateLimiter.middleware(200, 60_000, 'blacklist'), blacklistRoutes);
router.use('/billing-models', rateLimiter.middleware(200, 60_000, 'billing'), billingModelRoutes);
router.use('/fraud', rateLimiter.middleware(500, 60_000, 'fraud'), fraudRoutes);

module.exports = router;
