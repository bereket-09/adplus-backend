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


// PUT /api/v1/marketer/:id
// NOTE: the param MUST be `:id` — MarketerController.update reads req.params.id.
// It was previously `:userId`, so req.params.id was undefined and every update
// (KYC approve/reject, status change, profile save) 404'd with "marketer not found".
router.put('/:id', MarketerController.update);
router.post('/:id/kyc', upload.single('document'), MarketerController.uploadKYCDoc);

module.exports = router;
