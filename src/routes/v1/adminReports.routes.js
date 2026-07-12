const express = require('express');
const router = express.Router();
const Reports = require('../../controllers/adminReports.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// Admin-only aggregated reporting. Self-guarded (verifyToken + isAdmin) so the
// module is protected regardless of mount order in the v1 orchestrator.
// All handlers are time-bounded via ?days=N (clamped 1..365, default 30);
// /cohorts additionally accepts ?weeks=N (clamped 1..52, default 8).
router.use(verifyToken, isAdmin);

// GET /api/v1/admin/reports/revenue
router.get('/revenue', Reports.revenue);

// GET /api/v1/admin/reports/campaigns
router.get('/campaigns', Reports.campaigns);

// GET /api/v1/admin/reports/marketers
router.get('/marketers', Reports.marketers);

// GET /api/v1/admin/reports/rewards
router.get('/rewards', Reports.rewards);

// GET /api/v1/admin/reports/delivery
router.get('/delivery', Reports.delivery);

// GET /api/v1/admin/reports/engagement
router.get('/engagement', Reports.engagement);

// GET /api/v1/admin/reports/cohorts?weeks=N
router.get('/cohorts', Reports.cohorts);

// GET /api/v1/admin/reports/geo
router.get('/geo', Reports.geo);

// GET /api/v1/admin/reports/devices
router.get('/devices', Reports.devices);

// GET /api/v1/admin/reports/risk
router.get('/risk', Reports.risk);

module.exports = router;
