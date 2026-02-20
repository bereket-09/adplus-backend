const User = require('../models/user.model');
const Marketer = require('../models/marketer.model');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

exports.adminLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email?.toLowerCase().trim();
        logger.info(`AuthController.adminLogin - Login attempt for: ${normalizedEmail}`);

        if (!normalizedEmail || !password) {
            return res.status(400).json({ status: false, error: 'Email and password required' });
        }

        const user = await User.findOne({ email: normalizedEmail, role: 'admin' });
        if (!user) {
            return res.status(401).json({ status: false, error: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ status: false, error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            {
                id: user._id,
                role: 'admin',
                email: user.email,
                name: user.name
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            status: true,
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: 'admin'
            }
        });
    } catch (err) {
        logger.error(`AuthController.adminLogin - Error: ${err.message}`);
        next(err);
    }
};

exports.me = async (req, res) => {
    try {
        res.json({
            status: true,
            user: req.user
        });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
};
