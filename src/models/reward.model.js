const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  msisdn: { type: String, required: true },
  token: { type: String, required: true },
  ad_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  offer_id: { type: String, required: true },
  status: { type: String, enum: ['pending', 'granted', 'failed'], default: 'granted' },
  granted_at: { type: Date, default: Date.now }
}, { timestamps: true });

// Indexes — previously none.
rewardSchema.index({ ad_id: 1, granted_at: -1 });
rewardSchema.index({ msisdn: 1, granted_at: -1 });
rewardSchema.index({ status: 1, granted_at: -1 });
// Unique per watch token => a double-complete can never mint two rewards.
rewardSchema.index({ token: 1 }, { unique: true });

module.exports = mongoose.model('Reward', rewardSchema);
