const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const SystemChangeAudit = require('../models/systemChangeAudit.model');
const logger = require('../utils/logger');
const path = require("path");
const fs = require("fs");

/**
 * CREATE AD + FILE UPLOAD
 * Handles video upload, renames file using AD ID, validates marketer & budget.
 */
exports.createWithUpload = async (req, res, next) => {
  try {
    // console.log("🚀 Headers:", req.headers);
    // console.log("🚀 req.body:", req.body);
    // console.log("🚀 req.file:", req.file);

    const {
      marketer_id,
      campaign_name,
      title,
      cost_per_view,
      budget_allocation,
      description,
      start_date,
      end_date
    } = req.body; // Multer has already populated this

    if (!req.file) {
      return res.status(400).json({ status: false, error: "Video file is required" });
    }
    // 1. Validate marketer
    const marketer = await Marketer.findById(marketer_id);
    if (!marketer) {
      logger.error(`Marketer ${marketer_id} not found`);
      return res.status(404).json({ status: false, error: "Marketer not found" });
    }

    // 2. Validate budget
    let remaining_budget = null;
    if (budget_allocation && !isNaN(Number(budget_allocation))) {
      const budgetNum = Number(budget_allocation);
      if (marketer.remaining_budget < budgetNum) {
        logger.error("Insufficient marketer budget");
        return res.status(400).json({
          status: false,
          error: "Insufficient remaining budget"
        });
      }
      remaining_budget = budgetNum;
    }

    // 3. Validate file upload
    if (!req.file) {
      logger.error("No video file uploaded");
      return res.status(400).json({
        status: false,
        error: "Video file is required"
      });
    }

    const tempFilename = req.file.filename; // temporary filename from multer

    // 4. Create Ad record before renaming video
    const ad = await Ad.create({
      marketer_id,
      campaign_name,
      title,
      cost_per_view,
      budget_allocation: budget_allocation || null,
      remaining_budget,
      description,
      video_file_path: null, // assigned after rename
      start_date,
      end_date,
      status: "pending_approval",
      created_at: new Date()
    });

    // 5. Rename uploaded file → <adId>-<originalname>
    const uploadFolder = path.join(__dirname, "..", "public", "uploaded_videos");
    const oldPath = path.join(uploadFolder, tempFilename);

    const newFileName = `${ad._id}-${tempFilename}`;
    const newPath = path.join(uploadFolder, newFileName);

    fs.renameSync(oldPath, newPath);

    // 6. Save final video_path
    ad.video_file_path = `/uploaded_videos/${newFileName}`;
    await ad.save();

    logger.info(`Ad created successfully: ${ad._id}`);

    res.json({ status: true, ad });
  } catch (err) {
    logger.error(`AdController.createWithUpload - Error: ${err.message}`);
    next(err);
  }
};

/**
 * APPROVE AD
 */
exports.approve = async (req, res, next) => {
  try {

    console.log("🚀 ~ req.body:", req.body)
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
 * UPDATE AD + OPTIONAL FILE REPLACEMENT
 */
exports.update = async (req, res, next) => {
  try {
    const { adId } = req.params;

    const ad = await Ad.findById(adId);
    if (!ad) {
      return res.status(404).json({ status: false, error: 'Ad not found' });
    }

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

    // If a new video is uploaded
    if (req.file) {
      const uploadFolder = path.join(__dirname, "..", "public", "uploaded_videos");

      // Remove old file if exists
      if (ad.video_file_path) {
        const oldFile = path.join(uploadFolder, path.basename(ad.video_file_path));
        if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      }

      const newFileName = `${ad._id}-${req.file.filename}`;
      const newPath = path.join(uploadFolder, newFileName);

      // Move uploaded temp file
      fs.renameSync(req.file.path, newPath);

      ad.video_file_path = `/uploaded_videos/${newFileName}`;
      changedFields.video_file_path = {
        old: oldValues.video_file_path,
        new: ad.video_file_path
      };
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
* GET VIDEO FILE
* Streams the video for the given ad ID
*/
exports.getVideo = async (req, res, next) => {
  try {
    logger.info(`AdController.getVideo - Fetching video for ad ${req.params.adId}`);

    if (!req.params.adId) {
      return res.status(400).json({ status: false, error: 'Ad ID is required' });
    }
    const { adId } = req.params;

    const ad = await Ad.findById(adId);
    if (!ad || !ad.video_file_path) {
      return res.status(404).json({ status: false, error: 'Video not found' });
    }

    const videoPath = path.join(__dirname, '..', 'public', ad.video_file_path);

    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ status: false, error: 'Video file missing on server' });
    }

    // Set headers for streaming
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Partial content requested (for streaming)
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      // Full video
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(videoPath).pipe(res);
    }

  } catch (err) {
    logger.error(`AdController.getVideo - ${err.message}`);
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
