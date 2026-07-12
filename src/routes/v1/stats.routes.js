const express = require('express');
const router = express.Router();
const StatsController = require('../../controllers/stats.controller');

// All stats routes are read-only. verifyToken is applied globally in
// v1/index.js before these are mounted, so req.user is populated here.

// GET /api/v1/stats/campaign/:adId?days=N
router.get('/campaign/:adId', StatsController.getCampaignStats);

// GET /api/v1/stats/campaign/:adId/timeseries?days=N
router.get('/campaign/:adId/timeseries', StatsController.getCampaignTimeseries);

// GET /api/v1/stats/marketer/:marketerId/overview?days=N
router.get('/marketer/:marketerId/overview', StatsController.getMarketerOverview);

module.exports = router;
