const express = require('express');
const router = express.Router();
const BannerAdController = require('../../controllers/bannerAd.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// ==========================================================
// PUBLIC ROUTES (No JWT) — must be declared before verifyToken
// ==========================================================
router.get('/serve', BannerAdController.serve);
router.post('/:id/impression', BannerAdController.impression);
router.post('/:id/click', BannerAdController.click);

// ==========================================================
// PROTECTED ROUTES (verifyToken) — marketer create/mine/edit
// ==========================================================
router.use(verifyToken);

router.post('/', BannerAdController.create);
router.get('/mine', BannerAdController.mine);
router.put('/:id', BannerAdController.update);

// ==========================================================
// ADMIN ROUTES (verifyToken + isAdmin)
// ==========================================================
router.get('/list', isAdmin, BannerAdController.list);
router.post('/approve', isAdmin, BannerAdController.approve);

module.exports = router;
