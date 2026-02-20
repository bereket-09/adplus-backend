const SystemConfig = require('../models/systemConfig.model');
const logger = require('../utils/logger');

exports.getConfig = async (req, res, next) => {
    try {
        const configs = await SystemConfig.find({});
        res.json({ status: true, configs });
    } catch (err) {
        logger.error(`SystemConfigController.getConfig - Error: ${err.message}`);
        next(err);
    }
};

exports.updateConfig = async (req, res, next) => {
    try {
        const { key, value } = req.body;
        logger.info(`SystemConfigController.updateConfig - Updating ${key} to ${value}`);

        const config = await SystemConfig.findOneAndUpdate(
            { key },
            { value, updated_at: new Date() },
            { upsert: true, new: true }
        );

        res.json({ status: true, config });
    } catch (err) {
        logger.error(`SystemConfigController.updateConfig - Error: ${err.message}`);
        next(err);
    }
};

exports.getMaintenanceStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'maintenance_mode' });
        res.json({
            status: true,
            maintenance_mode: config ? config.value : (process.env.MAINTENANCE_MODE === 'true')
        });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
}
