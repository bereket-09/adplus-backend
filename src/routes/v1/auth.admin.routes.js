const express = require('express');
const router = express.Router();
const AuthController = require('../../controllers/auth.controller');
const { verifyToken } = require('../../middleware/auth.middleware');

router.post('/login', AuthController.adminLogin);
router.get('/me', verifyToken, AuthController.me);

module.exports = router;
