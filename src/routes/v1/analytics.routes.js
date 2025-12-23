const express = require('express');
const router = express.Router();
const AnalyticsController = require('../../controllers/analytics.controller');
const adminAnalytics = require('../../controllers/adminAnalytics.controller');

// GET /api/v1/analytics/audits
router.get('/audits', AnalyticsController.getAudits);

// GET /api/v1/analytics/watch-links
router.get('/watch-links', AnalyticsController.getWatchLinks);

// GET /api/v1/analytics/ads
router.get('/ads', AnalyticsController.getAdsAnalytics);

// GET /api/v1/analytics/marketers
router.get('/marketers', AnalyticsController.getMarketersAnalytics);


// GET /api/v1/analytics/ad/:adId/detail
router.get('/ad/:adId/detail', AnalyticsController.getSingleAdDetail);

// GET /api/v1/analytics/ad/:adId/users
router.get('/ad/:adId/users', AnalyticsController.getAdUsers);

// GET /api/v1/analytics/user/:msisdn
router.get('/user/:msisdn/detail', AnalyticsController.getUserAnalytics);

// GET /api/v1/analytics/rewards
router.get('/rewards', AnalyticsController.getRewardsAnalytics);


// GET /api/v1/analytics/marketers
router.get('/marketer/:marketerId/analytics', AnalyticsController.getMarketerAnalytics);


router.get('/marketer/reports/:marketerId', AnalyticsController.getMarketerReports);




router.get('/admin/dashboard', adminAnalytics.getAdminDashboardAnalytics);


router.get('/admin/analysis', adminAnalytics.getAdminAnalysis);



router.get('/admin/fraud', adminAnalytics.getAdminFraudAnalytics);

module.exports = router;
