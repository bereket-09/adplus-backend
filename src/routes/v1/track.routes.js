const express = require('express');
const router = express.Router();
const TrackController = require('../../controllers/track.controller');

// POST /api/v1/track/start
router.post('/start', TrackController.start);

// POST /api/v1/track/complete
router.post('/complete', TrackController.complete);

module.exports = router;
