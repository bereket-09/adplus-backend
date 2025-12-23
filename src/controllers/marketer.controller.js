const Marketer = require('../models/marketer.model');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger'); // <-- import logger
const jwt = require("jsonwebtoken");

exports.create = async (req, res, next) => {
  try {
    const { name, email, password, total_budget, contact_info, status } = req.body;
    logger.info(`MarketerController.create - Creating marketer with email: ${email}`);

    const existing = await Marketer.findOne({ email });
    if (existing) {
      logger.error(`MarketerController.create - Email already exists: ${email}`);
      return res.status(400).json({ status: false, error: 'Email already exists' });
    }

    let hashedPassword = null;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password, salt);
    }

    const marketer = await Marketer.create({
      name,
      email,
      password: hashedPassword,
      total_budget,
      remaining_budget: total_budget,
      contact_info,
      status: status || 'pendingPassChange',
      created_at: new Date()
    });

    logger.info(`MarketerController.create - Marketer created: ${marketer._id}`);
    res.json({ status: true, marketer });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.email) {
      logger.error(`MarketerController.create - Duplicate email error: ${err.message}`);
      return res.status(400).json({ status: false, error: 'Email already exists' });
    }
    logger.error(`MarketerController.create - Error creating marketer: ${err.message}`);
    next(err);
  }
};

exports.updatePassword = async (req, res, next) => {
  try {
    const { userId, password } = req.body;
    logger.info(`MarketerController.updatePassword - Updating password for userId: ${userId}`);

    if (!userId || !password) {
      logger.error(`MarketerController.updatePassword - userId and password required`);
      return res.status(400).json({ status: false, error: 'userId and password required' });
    }

    const marketer = await Marketer.findById(userId);
    if (!marketer) {
      logger.error(`MarketerController.updatePassword - Marketer not found: ${userId}`);
      return res.status(404).json({ status: false, error: 'marketer not found' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    marketer.password = hashedPassword;
    if (marketer.status === 'pendingPassChange') marketer.status = 'active';

    await marketer.save();
    logger.info(`MarketerController.updatePassword - Password updated for marketer: ${userId}`);
    res.json({ status: true, message: 'Password updated', marketer });
  } catch (err) {
    logger.error(`MarketerController.updatePassword - Error updating password: ${err.message}`);
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const marketer = await Marketer.findById(req.params.id);
    if (!marketer) {
      logger.error(`MarketerController.get - Marketer not found: ${req.params.id}`);
      return res.status(404).json({ status: false, error: 'not found' });
    }
    logger.info(`MarketerController.get - Marketer fetched: ${req.params.id}`);
    res.json({ status: true, marketer });
  } catch (err) {
    logger.error(`MarketerController.get - Error fetching marketer: ${err.message}`);
    next(err);
  }
};

exports.list = async (req, res, next) => {
  try {
    const marketers = await Marketer.find({});
    logger.info(`MarketerController.list - Retrieved ${marketers.length} marketers`);
    res.json({ status: true, marketers });
    // console.log("🚀 ~ marketers:", marketers)
  } catch (err) {
    logger.error(`MarketerController.list - Error listing marketers: ${err.message}`);
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { name, email, total_budget, contact_info, status } = req.body;
    logger.info(`MarketerController.update - Updating marketer: ${userId}`);

    const marketer = await Marketer.findById(userId);
    if (!marketer) {
      logger.error(`MarketerController.update - Marketer not found: ${userId}`);
      return res.status(404).json({ status: false, error: 'marketer not found' });
    }

    if (email && email !== marketer.email) {
      const existing = await Marketer.findOne({ email });
      if (existing) {
        logger.error(`MarketerController.update - Duplicate email: ${email}`);
        return res.status(400).json({ status: false, error: 'Email already exists' });
      }
      marketer.email = email;
    }

    if (name) marketer.name = name;
    if (total_budget) {
      marketer.total_budget = total_budget;
      marketer.remaining_budget = Math.min(marketer.remaining_budget, total_budget);
    }
    if (contact_info) marketer.contact_info = contact_info;
    if (status) marketer.status = status;

    await marketer.save();
    logger.info(`MarketerController.update - Marketer updated: ${userId}`);
    res.json({ status: true, message: 'Marketer updated', marketer });
  } catch (err) {
    logger.error(`MarketerController.update - Error updating marketer: ${err.message}`);
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    logger.info(`MarketerController.login - Login attempt for: ${email}`);

    if (!email || !password) {
      return res.status(400).json({
        status: false,
        error: "email and password required",
      });
    }

    const marketer = await Marketer.findOne({ email });
    if (!marketer) {
      return res.status(404).json({
        status: false,
        error: "marketer not found or invalid credentials",
      });
    }

    if (!marketer.password) {
      return res.status(400).json({
        status: false,
        error: "Account has no password set",
      });
    }

    const valid = await bcrypt.compare(password, marketer.password);
    if (!valid) {
      return res.status(401).json({
        status: false,
        error: "marketer not found or invalid credentials",
      });
    }

    const token = jwt.sign(
      {
        user_id: marketer._id,
        role: "marketer",
        email: marketer.email,
        name: marketer.name,
        status: marketer.status,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    logger.info(`MarketerController.login - Login success: ${marketer._id}`);

    res.json({
      status: true,
      token,
      marketer: {
        id: marketer._id,
        name: marketer.name,
        email: marketer.email,
        status: marketer.status
      }
    });
  } catch (err) {
    logger.error(`MarketerController.login - Error: ${err.message}`);
    next(err);
  }
};