const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

exports.verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        logger.warn(`AuthMiddleware - No token provided for ${req.method} ${req.originalUrl || req.url}. Headers keys: ${Object.keys(req.headers).join(', ')}`);
        return res.status(403).json({ status: false, error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        // console.log(`AuthMiddleware - Token verified for user: ${decoded.user_id}`);
        next();
    } catch (err) {
        logger.error(`AuthMiddleware - Token verification failed for ${req.method} ${req.url}: ${err.message}. Token: ${token.substring(0, 10)}...`);
        return res.status(401).json({ status: false, error: 'Unauthorized' });
    }
};

exports.isAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        return res.status(403).json({ status: false, error: 'Require Admin Role' });
    }
};

exports.isMarketer = (req, res, next) => {
    if (req.user && req.user.role === 'marketer') {
        next();
    } else {
        return res.status(403).json({ status: false, error: 'Require Marketer Role' });
    }
};
