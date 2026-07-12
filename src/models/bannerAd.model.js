const mongoose = require('mongoose');

const bannerAdSchema = new mongoose.Schema({
  marketer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marketer', required: true },
  title: { type: String, required: true },
  image_url: { type: String, required: true },
  target_url: { type: String, required: true },
  placement: {
    type: String,
    enum: ['top', 'bottom', 'left', 'right', 'overlay'],
    required: true
  },
  pricing_model: {
    type: String,
    enum: ['cpm', 'cpc', 'flat'],
    required: true
  },
  rate: { type: Number, required: true, min: 0 },
  budget_allocation: { type: Number, required: true, min: 0 },
  remaining_budget: { type: Number, required: true, min: 0 },
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
// Marketer's own list, newest first
bannerAdSchema.index({ marketer_id: 1, created_at: -1 });

module.exports = mongoose.model('BannerAd', bannerAdSchema);
