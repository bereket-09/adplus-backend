const express = require('express');
const router = express.Router();
const BillingModelController = require('../../controllers/billingModel.controller');
const { isAdmin } = require('../../middleware/auth.middleware');

// Publicly available within protected scope (e.g. for marketers to list models)
router.get('/list', BillingModelController.list);
router.get('/:id', BillingModelController.get);

// Admin-only modification routes
router.use(isAdmin);
router.post('/create', BillingModelController.create);
router.put('/:id', BillingModelController.update);
router.delete('/:id', BillingModelController.delete);

module.exports = router;
