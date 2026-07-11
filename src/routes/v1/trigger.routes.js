const express = require('express');
const router = express.Router();
const TriggerController = require('../../controllers/trigger.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// OCS ingestion — authenticated by x-ocs-key (see OCS_TRIGGER_KEY), not JWT.
// POST /api/v1/trigger
router.post('/', TriggerController.ingest);

// Observability — JWT admin only.
// GET /api/v1/trigger/stats
router.get('/stats', verifyToken, isAdmin, TriggerController.stats);

module.exports = router;
