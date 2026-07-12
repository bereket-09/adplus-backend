const BannerAd = require('../models/bannerAd.model');
const supabase = require('../utils/supabaseClient');
const logger = require('../utils/logger');

const PLACEMENTS = ['top', 'bottom', 'left', 'right', 'overlay', 'reward'];
const PRICING_MODELS = ['cpm', 'cpc', 'flat'];

// Fields a marketer is allowed to set/edit (never budget/impressions/clicks/status directly)
const EDITABLE_FIELDS = ['title', 'image_url', 'target_url', 'placement', 'weight', 'start_date', 'end_date'];

// -------------------------------------------------------------------
// POST /banner  (marketer create => pending_approval)  [verifyToken]
// -------------------------------------------------------------------
exports.create = async (req, res, next) => {
  try {
    const {
      title, image_url, target_url, placement,
      pricing_model, rate, budget_allocation,
      start_date, end_date, weight
    } = req.body;

    if (!title || !image_url || !target_url) {
      return res.status(400).json({ status: false, error: 'title, image_url and target_url are required' });
    }
    if (!PLACEMENTS.includes(placement)) {
      return res.status(400).json({ status: false, error: 'Invalid placement' });
    }
    if (!PRICING_MODELS.includes(pricing_model)) {
      return res.status(400).json({ status: false, error: 'Invalid pricing_model' });
    }

    const rateNum = Number(rate);
    const budgetNum = Number(budget_allocation);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      return res.status(400).json({ status: false, error: 'rate must be a non-negative number' });
    }
    if (!Number.isFinite(budgetNum) || budgetNum < 0) {
      return res.status(400).json({ status: false, error: 'budget_allocation must be a non-negative number' });
    }

    const banner = await BannerAd.create({
      marketer_id: req.user.id,
      title,
      image_url,
      target_url,
      placement,
      pricing_model,
      rate: rateNum,
      budget_allocation: budgetNum,
      remaining_budget: budgetNum,
      weight: Number.isFinite(Number(weight)) ? Number(weight) : 1,
      start_date: start_date ? new Date(start_date) : undefined,
      end_date: end_date ? new Date(end_date) : undefined,
      status: 'pending_approval',
      created_at: new Date()
    });

    logger.info(`BannerAdController.create - Banner ${banner._id} created by marketer ${req.user.id}`);
    res.json({ status: true, banner });
  } catch (err) {
    logger.error(`BannerAdController.create - Error: ${err.message}`);
    next(err);
  }
};

// -------------------------------------------------------------------
// GET /banner/mine  (marketer own list)  [verifyToken]
// -------------------------------------------------------------------
exports.mine = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const banners = await BannerAd.find({ marketer_id: req.user.id })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    res.json({ status: true, banners });
  } catch (err) {
    logger.error(`BannerAdController.mine - Error: ${err.message}`);
    next(err);
  }
};

// -------------------------------------------------------------------
// PUT /banner/:id  (owner edit)  [verifyToken]
// -------------------------------------------------------------------
exports.update = async (req, res, next) => {
  try {
    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (updates.placement !== undefined && !PLACEMENTS.includes(updates.placement)) {
      return res.status(400).json({ status: false, error: 'Invalid placement' });
    }
    if (updates.start_date !== undefined) updates.start_date = new Date(updates.start_date);
    if (updates.end_date !== undefined) updates.end_date = new Date(updates.end_date);

    // Scope the update to the owner so a marketer can only edit their own banner (atomic).
    const banner = await BannerAd.findOneAndUpdate(
      { _id: req.params.id, marketer_id: req.user.id },
      { $set: updates },
      { new: true }
    ).lean();

    if (!banner) {
      return res.status(404).json({ status: false, error: 'Banner not found' });
    }

    logger.info(`BannerAdController.update - Banner ${req.params.id} edited by marketer ${req.user.id}`);
    res.json({ status: true, banner });
  } catch (err) {
    logger.error(`BannerAdController.update - Error: ${err.message}`);
    next(err);
  }
};

// -------------------------------------------------------------------
// GET /banner/list  (admin all)  [verifyToken + isAdmin]
// -------------------------------------------------------------------
exports.list = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.placement) query.placement = req.query.placement;
    if (req.query.marketer_id) query.marketer_id = req.query.marketer_id;
    if (req.query.owner) query.owner = req.query.owner; // 'house' | 'marketer'

    const banners = await BannerAd.find(query)
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    res.json({ status: true, banners });
  } catch (err) {
    logger.error(`BannerAdController.list - Error: ${err.message}`);
    next(err);
  }
};

// -------------------------------------------------------------------
// POST /banner/approve  ({id,status})  [verifyToken + isAdmin]
// -------------------------------------------------------------------
exports.approve = async (req, res, next) => {
  try {
    const { id, status } = req.body;
    if (!id) return res.status(400).json({ status: false, error: 'id is required' });
    if (!['active', 'paused', 'expired', 'pending_approval'].includes(status)) {
      return res.status(400).json({ status: false, error: 'Invalid status' });
    }

    const banner = await BannerAd.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true }
    ).lean();

    if (!banner) return res.status(404).json({ status: false, error: 'Banner not found' });

    logger.info(`BannerAdController.approve - Banner ${id} set to ${status} by admin ${req.user.id}`);
    res.json({ status: true, banner });
  } catch (err) {
    logger.error(`BannerAdController.approve - Error: ${err.message}`);
    next(err);
  }
};

// -------------------------------------------------------------------
// GET /banner/serve?placement=top&limit=1  [PUBLIC]
// Return active, in-schedule, in-budget banners for a placement.
// Rotate by weight + recency. Lean + limited.
// -------------------------------------------------------------------
exports.serve = async (req, res, next) => {
  try {
    const placement = req.query.placement;
    if (!PLACEMENTS.includes(placement)) {
      return res.status(400).json({ status: false, error: 'Invalid or missing placement' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 1, 10);
    const now = new Date();

    // House banners (admin-managed, e.g. the reward-screen slot) are free — no
    // budget gate. Marketer banners require remaining budget. The reward
    // placement is always a house slot.
    const isHouse = req.query.owner === 'house' || placement === 'reward';
    const match = {
      status: 'active',
      placement,
      $and: [
        { $or: [{ start_date: { $exists: false } }, { start_date: null }, { start_date: { $lte: now } }] },
        { $or: [{ end_date: { $exists: false } }, { end_date: null }, { end_date: { $gte: now } }] }
      ]
    };
    if (isHouse) match.owner = 'house';
    else match.remaining_budget = { $gt: 0 };

    // Early $match on the index, over-fetch a small pool for weighted rotation,
    // project only what the client renders.
    const candidates = await BannerAd.aggregate([
      { $match: match },
      { $sort: { created_at: -1 } },
      { $limit: 50 },
      {
        $project: {
          title: 1, image_url: 1, target_url: 1, placement: 1,
          pricing_model: 1, owner: 1, weight: 1, created_at: 1
        }
      }
    ]);

    // Weighted random rotation across the candidate pool.
    const banners = weightedPick(candidates, limit);

    res.json({ status: true, banners });
  } catch (err) {
    logger.error(`BannerAdController.serve - Error: ${err.message}`);
    next(err);
  }
};

// Weighted-random selection without replacement. Recency already applied by sort;
// weight biases which of the recent candidates actually get shown.
function weightedPick(items, n) {
  const pool = items.slice();
  const picked = [];
  while (pool.length && picked.length < n) {
    let total = 0;
    for (const it of pool) total += Math.max(0, it.weight || 0) + 0.0001; // epsilon so weight=0 still eligible
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= Math.max(0, pool[i].weight || 0) + 0.0001;
      if (r <= 0) { idx = i; break; }
    }
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// -------------------------------------------------------------------
// POST /banner/:id/impression  [PUBLIC]
// Atomic $inc impressions; for cpm deduct rate/1000 from remaining_budget.
// Auto-pause when budget hits <= 0. Rate-limit-friendly (single atomic op).
// -------------------------------------------------------------------
exports.impression = async (req, res, next) => {
  try {
    const banner = await BannerAd.findById(req.params.id)
      .select('pricing_model rate')
      .lean();

    if (!banner) return res.status(404).json({ status: false, error: 'Banner not found' });

    const cost = banner.pricing_model === 'cpm' ? (banner.rate || 0) / 1000 : 0;

    // Single atomic update: increment impressions and deduct budget together.
    // Guarded on status:active so paused/expired banners don't over-count.
    const updated = await BannerAd.findOneAndUpdate(
      { _id: req.params.id, status: 'active' },
      { $inc: { impressions: 1, remaining_budget: -cost } },
      { new: true }
    ).select('remaining_budget status').lean();

    // If nothing matched, it was not active; still acknowledge idempotently.
    if (!updated) {
      return res.json({ status: true, counted: false });
    }

    // Auto-pause once budget is exhausted (atomic, guard against races).
    if (cost > 0 && updated.remaining_budget <= 0 && updated.status === 'active') {
      await BannerAd.updateOne(
        { _id: req.params.id, status: 'active', remaining_budget: { $lte: 0 } },
        { $set: { status: 'paused' } }
      );
    }

    res.json({ status: true, counted: true });
  } catch (err) {
    logger.error(`BannerAdController.impression - Error: ${err.message}`);
    next(err);
  }
};

// -------------------------------------------------------------------
// POST /banner/:id/click  [PUBLIC]
// Atomic $inc clicks; for cpc deduct rate from remaining_budget.
// Auto-pause when budget hits <= 0.
// -------------------------------------------------------------------
exports.click = async (req, res, next) => {
  try {
    const banner = await BannerAd.findById(req.params.id)
      .select('pricing_model rate target_url')
      .lean();

    if (!banner) return res.status(404).json({ status: false, error: 'Banner not found' });

    const cost = banner.pricing_model === 'cpc' ? (banner.rate || 0) : 0;

    const updated = await BannerAd.findOneAndUpdate(
      { _id: req.params.id, status: 'active' },
      { $inc: { clicks: 1, remaining_budget: -cost } },
      { new: true }
    ).select('remaining_budget status').lean();

    if (!updated) {
      return res.json({ status: true, counted: false, target_url: banner.target_url });
    }

    if (cost > 0 && updated.remaining_budget <= 0 && updated.status === 'active') {
      await BannerAd.updateOne(
        { _id: req.params.id, status: 'active', remaining_budget: { $lte: 0 } },
        { $set: { status: 'paused' } }
      );
    }

    res.json({ status: true, counted: true, target_url: banner.target_url });
  } catch (err) {
    logger.error(`BannerAdController.click - Error: ${err.message}`);
    next(err);
  }
};

// ===================================================================
// HOUSE BANNERS — admin-managed, no marketer account, free rotation.
// ===================================================================

// POST /banner/house/upload  (multipart: image)  [admin]
// Uploads an image to Supabase and returns its public URL.
exports.uploadImage = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ status: false, error: 'image file required' });
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const filename = `house/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage
      .from('banners')
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) {
      logger.error(`BannerAdController.uploadImage - supabase: ${error.message}`);
      return res.status(502).json({ status: false, error: 'upload failed' });
    }
    const image_url = supabase.storage.from('banners').getPublicUrl(filename).data.publicUrl;
    res.json({ status: true, image_url });
  } catch (err) {
    logger.error(`BannerAdController.uploadImage - Error: ${err.message}`);
    next(err);
  }
};

// POST /banner/house  [admin]  create a house banner (active immediately).
exports.createHouse = async (req, res, next) => {
  try {
    const { title, image_url, target_url, placement, weight, start_date, end_date } = req.body;
    if (!title || !image_url) {
      return res.status(400).json({ status: false, error: 'title and image_url are required' });
    }
    const place = placement && PLACEMENTS.includes(placement) ? placement : 'reward';

    const banner = await BannerAd.create({
      owner: 'house',
      title,
      image_url,
      target_url: target_url || undefined,
      placement: place,
      pricing_model: 'house',
      rate: 0,
      budget_allocation: 0,
      remaining_budget: 0,
      weight: Number.isFinite(Number(weight)) ? Number(weight) : 1,
      start_date: start_date ? new Date(start_date) : undefined,
      end_date: end_date ? new Date(end_date) : undefined,
      status: 'active', // house banners are live on create (admin controls them)
      created_at: new Date(),
    });

    logger.info(`BannerAdController.createHouse - House banner ${banner._id} created by admin ${req.user.id}`);
    res.json({ status: true, banner });
  } catch (err) {
    logger.error(`BannerAdController.createHouse - Error: ${err.message}`);
    next(err);
  }
};

// DELETE /banner/:id  [admin]  remove a banner (house or marketer).
exports.remove = async (req, res, next) => {
  try {
    const del = await BannerAd.deleteOne({ _id: req.params.id });
    if (!del.deletedCount) return res.status(404).json({ status: false, error: 'Banner not found' });
    logger.info(`BannerAdController.remove - Banner ${req.params.id} deleted by admin ${req.user.id}`);
    res.json({ status: true });
  } catch (err) {
    logger.error(`BannerAdController.remove - Error: ${err.message}`);
    next(err);
  }
};
