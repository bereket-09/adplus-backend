const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const SystemChangeAudit = require('../models/systemChangeAudit.model');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require("fs");
// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * CREATE AD + VIDEO UPLOAD TO SUPABASE
 */
exports.createWithUpload = async (req, res, next) => {
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

    if (!req.file) {
      return res.status(400).json({ status: false, error: "Video file is required" });
    }

    // 1️⃣ Validate marketer
    const marketer = await Marketer.findById(marketer_id);
    if (!marketer) {
      logger.error(`Marketer ${marketer_id} not found`);
      return res.status(404).json({ status: false, error: "Marketer not found" });
    }

    // 2️⃣ Validate budget
    let remaining_budget = null;
    if (budget_allocation && !isNaN(Number(budget_allocation))) {
      const budgetNum = Number(budget_allocation);
      if (marketer.remaining_budget < budgetNum) {
        return res.status(400).json({ status: false, error: "Insufficient remaining budget" });
      }
      remaining_budget = budgetNum;
    }

    // 3️⃣ Create Ad record
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
      status: "pending_approval",
      created_at: new Date()
    });

    // 4️⃣ Upload file to Supabase (disk storage)
    const fileExt = path.extname(req.file.originalname);
    const supabaseFileName = `${ad._id}-${Date.now()}${fileExt}`;

    const fileStream = fs.createReadStream(req.file.path);

    const { error: uploadError } = await supabase.storage
      .from('videos')
      .upload(supabaseFileName, fileStream, {
        contentType: req.file.mimetype,
      });

    // Remove temp file
    fs.unlinkSync(req.file.path);

    if (uploadError) {
      logger.error(`Supabase upload error: ${uploadError.message}`);
      return res.status(500).json({ status: false, error: "Failed to upload video" });
    }


    // 5️⃣ Get public URL
    const { data: urlData, error: urlError } = supabase.storage
      .from('videos')
      .getPublicUrl(supabaseFileName);

    if (urlError) {
      logger.error(`Supabase getPublicUrl error: ${urlError.message}`);
      return res.status(500).json({ status: false, error: "Failed to get video URL" });
    }

    // 6️⃣ Save URL in Ad
    ad.video_file_path = urlData.publicUrl;
    await ad.save();

    logger.info(`Ad created successfully: ${ad._id}`);
    res.json({ status: true, ad });

  } catch (err) {
    logger.error(`AdController.createWithUpload - Error: ${err.message}`);
    next(err);
  }
};

/**
 * UPDATE AD + OPTIONAL VIDEO REPLACEMENT
 */
exports.update = async (req, res, next) => {
  try {
    const { adId } = req.params;
    const ad = await Ad.findById(adId);
    if (!ad) return res.status(404).json({ status: false, error: 'Ad not found' });

    const oldValues = { ...ad.toObject() };
    const changedFields = {};

    const fields = [
      "title", "campaign_name", "cost_per_view", "budget_allocation",
      "description", "start_date", "end_date", "status"
    ];

    fields.forEach((field) => {
      if (req.body[field] && req.body[field] !== ad[field]) {
        changedFields[field] = { old: ad[field], new: req.body[field] };
        ad[field] = req.body[field];
      }
    });

    // 🔄 Handle new video
    if (req.file) {
      const fileExt = path.extname(req.file.originalname);
      const supabaseFileName = `${ad._id}-${Date.now()}${fileExt}`;

      // Delete old file from Supabase (optional)
      if (ad.video_file_path) {
        const oldFile = ad.video_file_path.split('/').pop();
        await supabase.storage.from('videos').remove([oldFile]);
      }

      const { error: uploadError } = await supabase.storage
        .from('videos')
        .upload(supabaseFileName, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      if (uploadError) return res.status(500).json({ status: false, error: "Failed to upload video" });

      const { data: urlData } = supabase.storage.from('videos').getPublicUrl(supabaseFileName);
      ad.video_file_path = urlData.publicUrl;
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

/**
 * GET VIDEO FILE (redirect to Supabase public URL)
 */
exports.getVideo = async (req, res, next) => {
  try {
    const { adId } = req.params;
    const ad = await Ad.findById(adId);
    if (!ad || !ad.video_file_path) return res.status(404).json({ status: false, error: 'Video not found' });

    // Since bucket is public, just redirect
    res.redirect(ad.video_file_path);
  } catch (err) {
    logger.error(`AdController.getVideo - ${err.message}`);
    next(err);
  }
};



/**
 * APPROVE AD
 */
exports.approve = async (req, res, next) => {
  try {

    // console.log("🚀 ~ req.body:", req.body)
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

/**
 * LIST ADS
 */
exports.list = async (req, res, next) => {
  try {
    logger.info(`AdController.list - Fetching ads`);

    const ads = await Ad.find({})
      .populate("marketer_id", "name email");

    res.json({ status: true, ads });
  } catch (err) {
    logger.error(`AdController.list - ${err.message}`);
    next(err);
  }
};


/**
 * LIST ADS FOR A SINGLE MARKETER
 */
exports.listByMarketer = async (req, res, next) => {
  try {
    const { marketerId } = req.params;
    logger.info(`AdController.listByMarketer - Fetching ads for marketer: ${marketerId}`);

    // Validate marketer exists
    const marketer = await Marketer.findById(marketerId);
    if (!marketer) {
      return res.status(404).json({ status: false, message: "Marketer not found" });
    }

    // Find ads for this marketer
    const ads = await Ad.find({ marketer_id: marketerId })
      .populate("marketer_id", "name email");

    res.json({
      status: true,
      marketerId,
      marketerInfo: marketer,
      adCount: ads.length,
      ads
    });
  } catch (err) {
    logger.error(`AdController.listByMarketer - ${err.message}`);
    next(err);
  }
};
