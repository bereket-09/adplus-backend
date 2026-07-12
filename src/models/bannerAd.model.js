const mongoose = require('mongoose');

const bannerAdSchema = new mongoose.Schema({
  // 'marketer' = a marketer-owned paid banner; 'house' = admin-managed static
  // banner (partner advertisers with no marketer account), free + rotated.
  owner: { type: String, enum: ['marketer', 'house'], default: 'marketer' },
  // Only required for marketer-owned banners (house banners have no marketer).
  marketer_id: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Marketer',
    required: function () { return this.owner !== 'house'; }
  },
  title: { type: String, required: true },
  image_url: { type: String, required: true },
  target_url: { type: String },
  placement: {
    type: String,
    // 'reward' = the post-video reward/completion screen (house rotation slot).
    enum: ['top', 'bottom', 'left', 'right', 'overlay', 'reward'],
    required: true
  },
  pricing_model: {
    type: String,
    enum: ['cpm', 'cpc', 'flat', 'house'],
    default: 'house'
  },
  rate: { type: Number, default: 0, min: 0 },
  budget_allocation: { type: Number, default: 0, min: 0 },
  remaining_budget: { type: Number, default: 0, min: 0 },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  // weight drives rotation selection on /serve (higher = shown more often)
  weight: { type: Number, default: 1, min: 0 },
  status: {
    type: String,
    enum: ['pending_approval', 'active', 'paused', 'expired'],
    default: 'pending_approval'
  },
  start_date: { type: Date },
  end_date: { type: Date },
  created_at: { type: Date, default: Date.now }
});

// Serve/admin lookups by placement + status
bannerAdSchema.index({ status: 1, placement: 1 });
// House-banner serve (owner + placement + status) and admin listing.
bannerAdSchema.index({ owner: 1, status: 1, placement: 1 });
// Marketer's own list, newest first
bannerAdSchema.index({ marketer_id: 1, created_at: -1 });

module.exports = mongoose.model('BannerAd', bannerAdSchema);
