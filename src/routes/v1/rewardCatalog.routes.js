const express = require('express');
const router = express.Router();
const RewardCatalogController = require('../../controllers/rewardCatalog.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// ==========================================
// PUBLIC ROUTES (no auth)
// ==========================================
// Note: /admin must be declared before /:id so it is not captured as an id.
router.get('/', RewardCatalogController.listPublic);
router.get('/admin', verifyToken, isAdmin, RewardCatalogController.listAdmin);
router.get('/:id', RewardCatalogController.get);

// ==========================================
// ADMIN ROUTES (verifyToken + isAdmin)
// ==========================================
router.post('/', verifyToken, isAdmin, RewardCatalogController.create);
router.put('/:id', verifyToken, isAdmin, RewardCatalogController.update);
router.post('/:id/toggle', verifyToken, isAdmin, RewardCatalogController.toggle);
router.delete('/:id', verifyToken, isAdmin, RewardCatalogController.delete);

module.exports = router;
