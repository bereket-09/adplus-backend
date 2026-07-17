const Marketer = require('../models/marketer.model');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger'); // <-- import logger
const jwt = require("jsonwebtoken");
const path = require('path');
const supabase = require('../utils/supabaseClient');
const { isPaginated, parseLimit, parseCursor, applyCursorFilter, buildPage } = require('../utils/pagination');

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

exports.register = async (req, res, next) => {
  try {
    const { name, email, password, company_name, business_reg_number, business_address, contact_info, business_category, contact_person } = req.body;
    logger.info(`MarketerController.register - Registration attempt with email: ${email}`);

    const existing = await Marketer.findOne({ email });
    if (existing) {
      return res.status(400).json({ status: false, error: 'Email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const marketer = await Marketer.create({
      name,
      email,
      password: hashedPassword,
      company_name,
      business_reg_number,
      business_address,
      contact_info,
      business_category,
      contact_person,
      status: 'pending',
      total_budget: 0,
      remaining_budget: 0,
      created_at: new Date()
    });

    logger.info(`MarketerController.register - Marketer registered: ${marketer._id}`);
    res.json({ status: true, message: 'Registration submitted successfully. Awaiting approval.' });
  } catch (err) {
    logger.error(`MarketerController.register - Error: ${err.message}`);
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
    // Marketer is time-ordered on `created_at` (indexed via {created_at:-1}).
    // Keyset paginate on that key when ?limit/cursor are present.
    if (isPaginated(req.query)) {
      const pageLimit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      if (!cursor.valid) return res.status(400).json({ status: false, error: 'invalid cursor' });
      const filter = applyCursorFilter({}, cursor.date, 'created_at');

      const rows = await Marketer.find(filter)
        .select('-password') // never expose the password hash
        .sort({ created_at: -1 })
        .limit(pageLimit + 1)
        .lean();

      const { data, pagination } = buildPage(rows, pageLimit, 'created_at');
      logger.info(`MarketerController.list - Returned ${data.length} marketers (paginated)`);
      return res.json({ status: true, data, pagination });
    }

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
    const { name, email, total_budget, contact_info, status, company_name, business_reg_number, business_address, kyc_status } = req.body;
    const marketerId = req.params.id;
    logger.info(`MarketerController.update - Updating marketer: ${marketerId}`);

    const marketer = await Marketer.findById(marketerId);
    if (!marketer) {
      logger.error(`MarketerController.update - Marketer not found: ${marketerId}`);
      return res.status(404).json({ status: false, error: 'marketer not found' });
    }

    // AuthZ: this route sits behind verifyToken only, so without these checks any
    // logged-in marketer could edit ANY marketer (IDOR) and self-grant budget or
    // KYC approval. Admins may edit anyone; a marketer may edit only themselves,
    // and never the privileged fields (gated further below).
    const isAdminReq = req.user?.role === 'admin';
    // Bridge-minted tokens carry `id`; legacy Express marketer logins carried `user_id`.
    const requesterId = String(req.user?.id || req.user?.user_id || '');
    const isSelf = requesterId !== '' && requesterId === String(marketerId);
    if (!isAdminReq && !isSelf) {
      logger.warn(`MarketerController.update - FORBIDDEN: ${requesterId} tried to edit ${marketerId}`);
      return res.status(403).json({ status: false, error: 'forbidden' });
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
    if (contact_info) marketer.contact_info = contact_info;

    // ---- Privileged fields: ADMIN ONLY ----
    // A marketer must never be able to grant itself budget, flip its own status,
    // or self-approve KYC. Silently ignored (not an error) for self-edits so the
    // profile/registration save still succeeds with the fields it may set.
    if (isAdminReq) {
      if (total_budget !== undefined) {
        marketer.total_budget = total_budget;
        marketer.remaining_budget = Math.min(marketer.remaining_budget, total_budget);
      }
      if (status) marketer.status = status;
      if (kyc_status) marketer.kyc_status = kyc_status;
      if (req.body.admin_comments !== undefined) marketer.admin_comments = req.body.admin_comments;
    }

    // ---- Business / KYC info: owner or admin ----
    if (company_name) marketer.company_name = company_name;
    if (business_reg_number) marketer.business_reg_number = business_reg_number;
    if (business_address) marketer.business_address = business_address;
    if (req.body.business_category) marketer.business_category = req.body.business_category;

    // Contact Person nested logic
    if (req.body.contact_person) {
      marketer.contact_person = {
        ...marketer.contact_person?.toObject(),
        ...req.body.contact_person
      };
    }

    await marketer.save();
    logger.info(`MarketerController.update - Marketer updated: ${marketerId}`);
    res.json({ status: true, message: 'Marketer updated', marketer });
  } catch (err) {
    logger.error(`MarketerController.update - Error updating marketer: ${err.message}`);
    next(err);
  }
};

exports.uploadKYCDoc = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { doc_type } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ status: false, error: 'No file uploaded' });

    const marketer = await Marketer.findById(id);
    if (!marketer) return res.status(404).json({ status: false, error: 'Marketer not found' });

    const fileName = `kyc-${id}-${Date.now()}-${file.originalname.replace(/ /g, '_')}`;
    const { error } = await supabase.storage.from('kyc').upload(fileName, file.buffer, { contentType: file.mimetype });

    if (error) {
       logger.error(`Supabase upload error: ${error.message}`);
       throw error;
    }

    const { data } = supabase.storage.from('kyc').getPublicUrl(fileName);

    marketer.kyc_documents.push({
      doc_type: doc_type || 'Other',
      file_url: data.publicUrl,
      file_name: file.originalname,
      status: 'pending'
    });

    // Auto-update KYC status to pending if it's the first doc or rejected
    if (marketer.kyc_status === 'unverified' || marketer.kyc_status === 'rejected') {
       marketer.kyc_status = 'pending';
    }
    
    await marketer.save();
    logger.info(`MarketerController.uploadKYCDoc - Doc uploaded for marketer: ${id}`);
    res.json({ status: true, marketer });
  } catch (err) {
    logger.error(`MarketerController.uploadKYCDoc - Error: ${err.message}`);
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email?.toLowerCase().trim();

    logger.info(`MarketerController.login - Login attempt for: ${normalizedEmail}`);

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        status: false,
        error: "email and password required",
      });
    }

    const marketer = await Marketer.findOne({ email: normalizedEmail });
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