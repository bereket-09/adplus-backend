const express = require('express');
const router = express.Router();
const BlacklistController = require('../../controllers/blacklist.controller');

// GET /api/v1/blacklist/stats
router.get('/stats', BlacklistController.stats);

// GET /api/v1/blacklist
router.get('/', BlacklistController.list);

// POST /api/v1/blacklist
router.post('/', BlacklistController.add);

// POST /api/v1/blacklist/bulk
router.post('/bulk', BlacklistController.bulkAdd);

// PUT /api/v1/blacklist/:id
router.put('/:id', BlacklistController.update);

// DELETE /api/v1/blacklist/:id  (soft deactivate)
router.delete('/:id', BlacklistController.remove);

// DELETE /api/v1/blacklist/:id/permanent
router.delete('/:id/permanent', BlacklistController.permanentDelete);

module.exports = router;
