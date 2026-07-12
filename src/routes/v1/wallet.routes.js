const express = require('express');
const router = express.Router();
const WalletController = require('../../controllers/wallet.controller');
const { verifyToken } = require('../../middleware/auth.middleware');

// All wallet routes require an authenticated marketer (req.user.id).

// GET /api/v1/wallet/balance
router.get('/balance', verifyToken, WalletController.getBalance);

// GET /api/v1/wallet/transactions
router.get('/transactions', verifyToken, WalletController.getTransactions);

// POST /api/v1/wallet/topup
router.post('/topup', verifyToken, WalletController.topUp);

module.exports = router;
