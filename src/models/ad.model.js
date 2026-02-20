const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  marketer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marketer', required: true },
  campaign_name: String,
  title: String,
  cost_per_view: Number,
  budget_allocation: Number,
  remaining_budget: Number,
  description: String,
  video_file_path: String,
  start_date: Date,
  end_date: Date,
  priority: { type: Number, default: 5 }, // 1-10, 10 being highest
  rate_tier: { type: String, enum: ['normal', 'premium'], default: 'normal' },
  campaign_type: { type: String, enum: ['video_ads', 'banner_ads', 'interstitial'], default: 'video_ads' },
  tags: [String], // e.g. ['sports', 'music', 'news']
  status: { type: String, enum: ['pending_approval', 'active', 'paused', 'expired'], default: 'pending_approval' },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Ad', adSchema);
