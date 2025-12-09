const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const SystemChangeAudit = require('../models/systemChangeAudit.model');
const logger = require('../utils/logger');
const path = require("path");
const fs = require("fs");

exports.create = async (req, res, next) => {
  try {
    const {
      marketer_id,
      campaign_name,
      title,
      cost_per_view,
      budget_allocation,
      description,
      start_date,
      end_date
    } = req.body;

    logger.info(`AdController.create - Attempting to create ad for marketer ${marketer_id}`);

    const marketer = await Marketer.findById(marketer_id);
    if (!marketer) {
      logger.error(`AdController.create - Marketer ${marketer_id} not found`);
      return res.status(404).json({ status: false, error: 'Marketer not found' });
    }

    let remaining_budget = null;
    if (budget_allocation && typeof budget_allocation === 'number') {
      if (marketer.remaining_budget < budget_allocation) {
        logger.error(`AdController.create - Not enough remaining budget`);
        return res.status(400).json({ status: false, error: 'Insufficient remaining budget' });
      }
      remaining_budget = budget_allocation;
    }

    // Step 1: Handle file upload
    let savedVideoPath = null;
    if (req.file) {
      savedVideoPath = req.file.filename; // Temporary filename from multer
    }

    // Step 2: Create Ad first
    const ad = await Ad.create({
      marketer_id,
      campaign_name,
      title,
      cost_per_view,
      budget_allocation: budget_allocation || null,
      remaining_budget,
      description,
      video_file_path: null,
      start_date,
      end_date,
      status: 'pending_approval',
      created_at: new Date()
    });

    // Step 3: Rename video file using AD ID
    if (savedVideoPath) {
      const uploadFolder = path.join(__dirname, "..", "public", "uploaded-videos");
      const originalPath = path.join(uploadFolder, savedVideoPath);

      const newFileName = `${ad._id}-${savedVideoPath}`;
      const newPath = path.join(uploadFolder, newFileName);

      fs.renameSync(originalPath, newPath);

      ad.video_file_path = `/uploaded-videos/${newFileName}`;
      await ad.save();
    }

    logger.info(`AdController.create - Ad created successfully: ${ad._id}`);

    res.json({ status: true, ad });
  } catch (err) {
    logger.error(`AdController.create - Error: ${err.message}`);
    next(err);
  }
};

exports.approve = async (req, res, next) => {
  try {
    const { ad_id, performed_by } = req.body;

    logger.info(`AdController.approve - Approving ad ${ad_id}`);

    const ad = await Ad.findById(ad_id);
    if (!ad) {
      return res.status(404).json({ status: false, error: 'Ad not found' });
    }

    const oldValues = { ...ad.toObject() };

    ad.status = 'active';
    await ad.save();

    await SystemChangeAudit.create({
      entity_type: 'ad',
      entity_id: ad._id,
      action: 'approve',
      changed_fields: { status: { old: oldValues.status, new: 'active' } },
      performed_by
    });

    res.json({ status: true, ad });
  } catch (err) {
    logger.error(`AdController.approve - ${err.message}`);
    next(err);
  }
};

exports.list = async (req, res, next) => {
  try {
    logger.info(`AdController.list - Returning ads`);

    const ads = await Ad.find({})
      .populate("marketer_id", "name email");

    res.json({ status: true, ads });
  } catch (err) {
    logger.error(`AdController.list - ${err.message}`);
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { adId } = req.params;

    const ad = await Ad.findById(adId);
    if (!ad) {
      return res.status(404).json({ status: false, error: 'Ad not found' });
    }

    const oldValues = { ...ad.toObject() };
    const changedFields = {};

    // Update normal fields
    const fields = ["title", "campaign_name", "cost_per_view", "budget_allocation", "description", "start_date", "end_date", "status"];
    fields.forEach(field => {
      if (req.body[field] && req.body[field] !== ad[field]) {
        changedFields[field] = { old: ad[field], new: req.body[field] };
        ad[field] = req.body[field];
      }
    });

    // Handle file update
    if (req.file) {
      const uploadFolder = path.join(__dirname, "..", "public", "uploaded-videos");

      // remove old file (optional)
      if (ad.video_file_path) {
        const oldFile = path.join(uploadFolder, path.basename(ad.video_file_path));
        if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      }

      const newFileName = `${ad._id}-${req.file.filename}`;
      const newPath = path.join(uploadFolder, newFileName);
      fs.renameSync(req.file.path, newPath);

      ad.video_file_path = `/uploaded-videos/${newFileName}`;
      changedFields.video_file_path = { old: oldValues.video_file_path, new: ad.video_file_path };
    }

    await ad.save();

    if (Object.keys(changedFields).length > 0) {
      await SystemChangeAudit.create({
        entity_type: 'ad',
        entity_id: ad._id,
        action: "update",
        changed_fields: changedFields,
        performed_by: req.body.performed_by
      });
    }

    res.json({ status: true, ad });
  } catch (err) {
    logger.error(`AdController.update - Error: ${err.message}`);
    next(err);
  }
};
