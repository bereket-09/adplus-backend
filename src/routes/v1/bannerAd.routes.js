const express = require('express');
const multer = require('multer');
const router = express.Router();
const BannerAdController = require('../../controllers/bannerAd.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// In-memory upload for Supabase (house-banner images, max 5MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// House banners (admin-managed, no marketer account).
router.post('/house/upload', isAdmin, upload.single('image'), BannerAdController.uploadImage);
router.post('/house', isAdmin, BannerAdController.createHouse);
router.delete('/:id', isAdmin, BannerAdController.remove);

module.exports = router;
