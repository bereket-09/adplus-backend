const express = require('express');
const router = express.Router();

const linkRoutes = require('./link.routes');
const trackRoutes = require('./track.routes');
const marketerRoutes = require('./marketer.routes');
const adRoutes = require('./ad.routes');
const analyticsRoutes = require('./analytics.routes');
const budgetRoutes = require('./budget.routes');
const marketerAuthRoutes = require('./auth.marketer.routes');
const blacklistRoutes = require('./blacklist.routes');

const rateLimiter = require('../../utils/rateLimiter');

// Apply rate limiting to high-traffic endpoints
router.use('/link', rateLimiter.middleware(200, 60_000, 'link'), linkRoutes);
router.use('/video', rateLimiter.middleware(200, 60_000, 'video'), linkRoutes); // token route uses link controller
router.use('/track', rateLimiter.middleware(300, 60_000, 'track'), trackRoutes);

// Standard rate limits for admin/management routes
router.use('/marketer', rateLimiter.middleware(100, 60_000, 'marketer'), marketerRoutes);
router.use('/ad', rateLimiter.middleware(100, 60_000, 'ad'), adRoutes);
router.use('/analytics', rateLimiter.middleware(50, 60_000, 'analytics'), analyticsRoutes);
router.use('/budget', rateLimiter.middleware(50, 60_000, 'budget'), budgetRoutes);
router.use("/auth/marketer", rateLimiter.middleware(20, 60_000, 'auth'), marketerAuthRoutes);
router.use('/blacklist', rateLimiter.middleware(50, 60_000, 'blacklist'), blacklistRoutes);

// Health check endpoint
router.get('/health', (req, res) => {
    const AdEngine = require('../../utils/adEngine');
    res.json({
        status: true,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: {
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
            heap_used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            heap_total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
        },
        engine: AdEngine.getStats()
    });
});

module.exports = router;
