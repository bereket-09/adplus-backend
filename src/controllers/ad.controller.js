const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const SystemChangeAudit = require('../models/systemChangeAudit.model');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegInstaller);
const AdEngine = require('../utils/adEngine');
const { isPaginated, parseLimit, parseCursor, applyCursorFilter, buildPage } = require('../utils/pagination');
// Initialize Supabase client (used for getPublicUrl - a local synchronous operation)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Axios instance for direct Supabase Storage REST API calls
// (bypasses Supabase JS client's native fetch which has issues with binary uploads in Node 20)
const supabaseAxios = axios.create({
  baseURL: `${process.env.SUPABASE_URL}/storage/v1`,
  headers: {
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
  },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

/**
 * Upload a file buffer to Supabase Storage via REST API
 */
async function uploadToSupabase(bucket, filename, buffer, mimetype) {
  const url = `/object/${bucket}/${filename}`;
  const response = await supabaseAxios.post(url, buffer, {
    headers: { 'Content-Type': mimetype },
  });
  return response.data;
}

/**
 * Get a public URL for a Supabase Storage file
 */
function getPublicUrl(bucket, filename) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
  return data.publicUrl;
}

/**
 * CREATE AD + VIDEO UPLOAD TO SUPABASE
 */
/**
 * CREATE AD + VIDEO UPLOAD TO SUPABASE (With HLS Fallback)
 */
exports.createWithUpload = async (req, res, next) => {
  let tmpDir = null; // Defined outside to ensure cleanup access
  try {
    const {
      marketer_id, campaign_name, title, cost_per_view,
      budget_allocation, description, video_description,
      start_date, end_date, cta_text, cta_link,
      payment_type, billing_model, cost_per_click
    } = req.body;

    const adDescription = video_description || description;
    const files = req.files || {};
    const videoFile = files.video ? files.video[0] : null;
    const bannerFile = files.banner ? files.banner[0] : null;

    if (!videoFile) {
      return res.status(400).json({ status: false, error: "Video file is required" });
    }

    // 1️⃣ Validate marketer & budget
    const marketer = await Marketer.findById(marketer_id);
    if (!marketer) return res.status(404).json({ status: false, error: "Marketer not found" });

    let remaining_budget = null;
    if (budget_allocation && !isNaN(Number(budget_allocation))) {
      const budgetNum = Number(budget_allocation);
      if (marketer.remaining_budget < budgetNum) {
        return res.status(400).json({ status: false, error: "Insufficient budget" });
      }
      remaining_budget = budgetNum;
    }

    // 2️⃣ Create Ad record
    const ad = await Ad.create({
      marketer_id, campaign_name, title,
      cost_per_view: Number(cost_per_view) || 0,
      cost_per_click: Number(cost_per_click) || 0,
      budget_allocation: budget_allocation || null,
      remaining_budget, description: adDescription,
      cta_text, cta_link, payment_type: payment_type || 'standard',
      billing_model: billing_model || 'view_only',
      start_date, end_date, status: "pending_approval"
    });

    // 3️⃣ Attempt HLS Transcoding
    let uploadSuccessful = false;
    const videoExt = path.extname(videoFile.originalname);

    try {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hls-'));
      const inputPath = path.join(tmpDir, 'input' + videoExt);
      await fs.promises.writeFile(inputPath, videoFile.buffer);

      const hlsOutputDir = path.join(tmpDir, 'output');
      await fs.promises.mkdir(hlsOutputDir);

      logger.info(`Starting HLS Transcoding for Ad: ${ad._id}`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .addOptions(['-profile:v baseline', '-level 3.0', '-start_number 0', '-hls_time 10', '-hls_list_size 0', '-f hls'])
          .output(path.join(hlsOutputDir, 'playlist.m3u8'))
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      const hlsFiles = await fs.promises.readdir(hlsOutputDir);
      const folderName = `${ad._id}-hls-${Date.now()}`;

      // Upload segments
      const uploadPromises = hlsFiles.map(async (file) => {
        const filePath = path.join(hlsOutputDir, file);
        const fileBuffer = await fs.promises.readFile(filePath);
        const mimeType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
        const { error } = await supabase.storage.from('videos').upload(`${folderName}/${file}`, fileBuffer, { contentType: mimeType });
        if (error) throw error;
      });

      await Promise.all(uploadPromises);
      ad.video_file_path = supabase.storage.from('videos').getPublicUrl(`${folderName}/playlist.m3u8`).data.publicUrl;
      uploadSuccessful = true;
      logger.info(`HLS success for Ad: ${ad._id}`);

    } catch (hlsError) {
      logger.error(`HLS Failed: ${hlsError.message}. Falling back to normal upload.`);

      // 4️⃣ FALLBACK: Normal Upload
      const normalFileName = `${ad._id}-fallback-${Date.now()}${videoExt}`;
      const { data, error: fallbackError } = await supabase.storage
        .from('videos')
        .upload(normalFileName, videoFile.buffer, {
          contentType: videoFile.mimetype,
          upsert: true
        });

      if (fallbackError) {
        throw new Error(`Fallback upload also failed: ${fallbackError.message}`);
      }

      ad.video_file_path = supabase.storage.from('videos').getPublicUrl(normalFileName).data.publicUrl;
      uploadSuccessful = true;
    } finally {
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }

    // 5️⃣ Upload Banner
    if (bannerFile) {
      const bannerName = `${ad._id}-banner-${Date.now()}${path.extname(bannerFile.originalname)}`;
      const { error: bErr } = await supabase.storage.from('banners').upload(bannerName, bannerFile.buffer, { contentType: bannerFile.mimetype });
      if (!bErr) ad.banner_url = supabase.storage.from('banners').getPublicUrl(bannerName).data.publicUrl;
    }

    await ad.save();
    AdEngine.invalidateCache();
    res.json({ status: true, ad });

  } catch (err) {
    logger.error(`AdController.createWithUpload - Fatal Error: ${err.message}`);
    // If we haven't even saved the ad or both uploads failed, cleanup if necessary
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
      "description", "start_date", "end_date", "status",
      "cta_text", "cta_link", "banner_url", "priority", "rate_tier"
    ];

    fields.forEach((field) => {
      if (req.body[field] !== undefined && req.body[field] !== ad[field]) {
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

    AdEngine.invalidateCache(); // Refresh recommendation engine

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
    const { id, file } = req.params;
    logger.info(`AdController.getVideo - Resource request: ${id}${file ? `/${file}` : ''}`);

    const ad = await Ad.findById(id);
    if (!ad) {
      logger.warn(`AdController.getVideo - Ad document NOT found in MongoDB for id: ${id}`);
      return res.status(404).json({ status: false, error: 'Ad record not found in database' });
    }

    if (!ad.video_file_path) {
      logger.error(`AdController.getVideo - video_file_path is EMPTY for ad: ${id}`);
      return res.status(404).json({ status: false, error: 'Video file path not found in record' });
    }

    // Handle HLS/Streaming relative file requests (if file path has folder structure)
    if (file) {
      // Assume ad.video_file_path is the base URL point to playlist.m3u8 or the folder
      // We extract the base bucket path and append the file name
      const baseUrlParts = ad.video_file_path.split('/');
      baseUrlParts.pop(); // Remove the filename (e.g. playlist.m3u8)
      const streamingUrl = `${baseUrlParts.join('/')}/${file}`;
      return res.redirect(streamingUrl);
    }

    // Since bucket is public, just redirect to primary source
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

    AdEngine.invalidateCache(); // Refresh recommendation engine

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

    // Ad is time-ordered on `created_at` (indexed via {created_at:-1}).
    // Keyset paginate on that key when ?limit/cursor are present.
    const AD_PROJECTION = 'marketer_id campaign_name title cost_per_view cost_per_click budget_allocation remaining_budget status priority rate_tier campaign_type start_date end_date banner_url video_file_path created_at';

    if (isPaginated(req.query)) {
      const pageLimit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      if (!cursor.valid) return res.status(400).json({ status: false, error: 'invalid cursor' });
      const filter = applyCursorFilter({}, cursor.date, 'created_at');

      const rows = await Ad.find(filter)
        .select(AD_PROJECTION)
        .populate('marketer_id', 'name email')
        .sort({ created_at: -1 })
        .limit(pageLimit + 1)
        .lean();

      const { data, pagination } = buildPage(rows, pageLimit, 'created_at');
      logger.info(`AdController.list - Returned ${data.length} ads (paginated)`);
      return res.json({ status: true, data, pagination });
    }

    const ads = await Ad.find({})
      .populate("marketer_id", "name email")
      .sort({ created_at: -1 })
      .lean();

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
