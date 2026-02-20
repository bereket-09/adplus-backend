const express = require('express');
const router = express.Router();
const AdController = require('../../controllers/ad.controller');
const multer = require('multer');


// Use memory storage so req.file.buffer is available for Supabase upload
// (Supabase JS v2 uses Web fetch which cannot consume Node.js ReadStreams)
const upload = multer({ storage: multer.memoryStorage() });

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
