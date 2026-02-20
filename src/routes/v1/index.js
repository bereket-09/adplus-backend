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

const rateLimiter = require('../../utils/rateLimiter');
const { checkMaintenanceMode } = require('../../middleware/maintenance.middleware');

// Public routes (not affected by maintenance mode check internally)
router.use('/auth/admin', adminAuthRoutes);
router.use("/auth/marketer", rateLimiter.middleware(20, 60_000, 'auth'), marketerAuthRoutes);
router.get('/maintenance-status', require('../../controllers/systemConfig.controller').getMaintenanceStatus);

// Apply maintenance mode to ALL other routes
router.use(checkMaintenanceMode);

// Apply rate limiting to high-traffic endpoints
router.use('/link', rateLimiter.middleware(200, 60_000, 'link'), linkRoutes);
router.use('/video', rateLimiter.middleware(200, 60_000, 'video'), linkRoutes); // token route uses link controller
router.use('/track', rateLimiter.middleware(300, 60_000, 'track'), trackRoutes);

// Health check endpoint (Public)
router.get('/health', (req, res) => {
    const AdEngine = require('../../utils/adEngine');
    res.json({
        status: true,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        engine: AdEngine.getStats()
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
router.use('/ad', rateLimiter.middleware(500, 60_000, 'ad'), adRoutes);
router.use('/analytics', rateLimiter.middleware(1000, 60_000, 'analytics'), analyticsRoutes);
router.use('/budget', rateLimiter.middleware(500, 60_000, 'budget'), budgetRoutes);
router.use('/system-config', rateLimiter.middleware(100, 60_000, 'system'), systemConfigRoutes);
router.use('/blacklist', rateLimiter.middleware(200, 60_000, 'blacklist'), blacklistRoutes);

module.exports = router;
