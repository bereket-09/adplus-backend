const express = require('express');
const router = express.Router();
const BudgetController = require('../../controllers/budget.controller');

// POST /api/v1/budget/topup
router.post('/topup', BudgetController.topUp);

// POST /api/v1/budget/deduct
router.post('/deduct', BudgetController.deduct);


// New route to fetch transaction logs
router.get('/:marketerId/transactions', BudgetController.getTransactions);
module.exports = router;
