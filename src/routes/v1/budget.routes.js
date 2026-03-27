const express = require('express');
const router = express.Router();
const BudgetController = require('../../controllers/budget.controller');
const { isAdmin } = require('../../middleware/auth.middleware');

// ADMIN ONLY: Top up or Deduct budget manually
router.post('/topup', isAdmin, BudgetController.topUp);
router.post('/deduct', isAdmin, BudgetController.deduct);

// SHARED: New route to fetch transaction logs
router.get('/:marketerId/transactions', BudgetController.getTransactions);
module.exports = router;
