const express = require('express');
const router = express.Router();
const SystemConfigController = require('../../controllers/systemConfig.controller');
const { verifyToken, isAdmin } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, isAdmin, SystemConfigController.getConfig);
router.post('/update', verifyToken, isAdmin, SystemConfigController.updateConfig);
router.get('/maintenance-status', SystemConfigController.getMaintenanceStatus);

module.exports = router;
