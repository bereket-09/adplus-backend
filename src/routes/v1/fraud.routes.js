const express = require('express');
const router = express.Router();
const Fraud = require('../../controllers/fraudDashboard.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// Admin-only fraud observability.
router.use(verifyToken, isAdmin);
router.get('/overview', Fraud.overview);
router.get('/detections', Fraud.detections);
router.get('/blacklist-auto', Fraud.autoBlacklist);
router.get('/live', Fraud.live);

module.exports = router;
