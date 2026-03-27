const express = require('express');
const router = express.Router();
const AdController = require('../../controllers/ad.controller');
const TrackController = require('../../controllers/track.controller');
const { verifyToken, isAdmin, isMarketer } = require('../../middleware/auth.middleware');
const multer = require('multer');

// Memory storage for Supabase upload
const upload = multer({ storage: multer.memoryStorage() });

// PUBLIC ROUTES (No auth required for tracking)
router.post('/start', TrackController.start);
router.post('/complete', TrackController.complete);
router.post('/ping', TrackController.ping);
router.post('/click/:token', TrackController.click); // New Click Tracking
router.get('/video/:id/:file?', AdController.getVideo);

// MARKETER & SHARED ROUTES (Auth Required)
router.use(verifyToken);

// Move these BEFORE router.use(isAdmin) so marketers can access them
router.post('/create', upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'banner', maxCount: 1 }
]), AdController.createWithUpload);

router.get('/marketer/:marketerId', AdController.listByMarketer);

// Admin-only routes
router.use(isAdmin);

// LIST ALL ADS (Global Admin)
router.get('/list', AdController.list);

// APPROVE AD
router.post('/approve', AdController.approve);

module.exports = router;
