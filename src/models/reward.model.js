const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  msisdn: { type: String, required: true },
  token: { type: String, required: true },
  ad_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  offer_id: { type: String, required: true },
  status: { type: String, enum: ['pending', 'granted', 'failed'], default: 'granted' },
  granted_at: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Reward', rewardSchema);
