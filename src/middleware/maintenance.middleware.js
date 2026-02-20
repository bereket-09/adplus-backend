const SystemConfig = require('../models/systemConfig.model');

exports.checkMaintenanceMode = async (req, res, next) => {
    try {
        // Check ENV first
        if (process.env.MAINTENANCE_MODE === 'true') {
            return res.status(503).json({
                status: false,
                error: 'Maintenance Mode',
                message: 'The system is currently undergoing maintenance. Please try again later.'
            });
        }

        // Check DB
        const config = await SystemConfig.findOne({ key: 'maintenance_mode' });
        if (config && config.value === true) {
            // Allow admins to bypass maintenance mode if they are already logged in
            // This is useful for testing while in maintenance
            if (req.user && req.user.role === 'admin') {
                return next();
            }

            return res.status(503).json({
                status: false,
                error: 'Maintenance Mode',
                message: 'The system is currently undergoing maintenance. Please try again later.'
            });
        }

        next();
    } catch (err) {
        // If DB check fails, we proceed but log the error
        console.error('Maintenance Middleware Error:', err);
        next();
    }
};
