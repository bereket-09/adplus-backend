const express = require('express');
const router = express.Router();
const AdController = require('../../controllers/ad.controller');
const multer = require('multer');
const path = require('path');
const fs = require('fs');


// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../../public/uploaded_videos');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `video-${unique}${ext}`);
    }
});

const upload = multer({ storage });

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
