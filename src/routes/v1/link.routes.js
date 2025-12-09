const express = require('express');
const router = express.Router();
const LinkController = require('../../controllers/link.controller');

// POST /api/v1/link/create
router.post('/create', LinkController.createLink);

// GET /api/v1/video/:token
router.get('/:token', LinkController.getVideoByToken);

module.exports = router;
