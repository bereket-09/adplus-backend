const express = require('express');
const router = express.Router();

const linkRoutes = require('./link.routes');
const trackRoutes = require('./track.routes');
const marketerRoutes = require('./marketer.routes');
const adRoutes = require('./ad.routes');
const analyticsRoutes = require('./analytics.routes');
const budgetRoutes = require('./budget.routes');
const marketerAuthRoutes = require('./auth.marketer.routes');

router.use('/link', linkRoutes);
router.use('/video', linkRoutes); // token route uses link controller
router.use('/track', trackRoutes);
router.use('/marketer', marketerRoutes);
router.use('/ad', adRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/budget', budgetRoutes);
router.use("/auth/marketer", marketerAuthRoutes);



module.exports = router;
