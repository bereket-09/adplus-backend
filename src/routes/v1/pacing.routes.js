const express = require('express');
const router = express.Router();
const PacingController = require('../../controllers/pacing.controller');

// All pacing routes are read-only. verifyToken is applied globally in
// v1/index.js before these are mounted; /alerts scopes to req.user.id.

// GET /api/v1/pacing/alerts  (declared before /campaign/:adId to avoid capture)
router.get('/alerts', PacingController.getPacingAlerts);

// GET /api/v1/pacing/campaign/:adId
router.get('/campaign/:adId', PacingController.getCampaignPacing);

module.exports = router;
