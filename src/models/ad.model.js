const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  marketer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marketer', required: true },
  campaign_name: String,
  title: String,
  cost_per_view: Number,
  cost_per_click: { type: Number, default: 0 },
  budget_allocation: Number,
  remaining_budget: Number,
  description: String,
  reward_description: { type: String, default: '+ 50 GOLD' }, // e.g. "+ 50 Gold" or "100MB Data"
  video_file_path: String,
  
  // New Banner & CTA fields
  banner_url: String,
  cta_text: String,
  cta_link: String,
  
  // Flexible Configuration
  payment_type: { type: String, default: 'standard' }, // standard, premium, etc.
  billing_model: { type: String, default: 'view_only' },
  
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
