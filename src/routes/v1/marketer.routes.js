const express = require('express');
const router = express.Router();
const MarketerController = require('../../controllers/marketer.controller');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/v1/marketer/create
router.post('/create', MarketerController.create);

// POST /api/v1/marketer/update-password
router.post('/update-password', MarketerController.updatePassword);

// GET /api/v1/marketer/:id
router.get('/:id', MarketerController.get);

// GET list
router.get('/', MarketerController.list);


// PUT /api/v1/marketer/:userId
router.put('/:userId', MarketerController.update);
router.post('/:id/kyc', upload.single('document'), MarketerController.uploadKYCDoc);

module.exports = router;
