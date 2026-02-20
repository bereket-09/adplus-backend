const express = require('express');
const router = express.Router();
const AdController = require('../../controllers/ad.controller');
const multer = require('multer');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

// Use memory storage so req.file.buffer is available for Supabase upload
// (Supabase JS v2 uses Web fetch which cannot consume Node.js ReadStreams)
const upload = multer({ storage: multer.memoryStorage() });

// Ad management routes (verifyToken is now handled globally in v1/index.js)

// Marketer or Admin can list ads for a specific marketer
router.get('/marketer/:marketerId', AdController.listByMarketer);

// Admin-only routes
router.use(isAdmin);

// Multer parses the FormData fields automatically into req.body
router.post('/create', upload.single('video'), AdController.createWithUpload);

// APPROVE AD
router.post('/approve', AdController.approve);

// LIST ADS
router.get('/list', AdController.list);

// UPDATE AD
router.put('/:adId', AdController.update);

// GET /api/v1/ad/video/:adId
router.get('/video/:adId', AdController.getVideo);

router.get('/marketer/:marketerId', AdController.listByMarketer);

module.exports = router;
