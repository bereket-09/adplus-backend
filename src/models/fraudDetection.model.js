const mongoose = require('mongoose');

const fraudDetectionSchema = new mongoose.Schema({
  stage: String, // trigger|decide|open|start|complete|click
  subject: {
    msisdn: String,
    ip: String,
    deviceFp: String,
    token: String,
  },
  score: Number,
  action: String, // throttle|soft_block|challenge|hard_block
  reasons: [String],
  signals: [{ id: String, value: mongoose.Schema.Types.Mixed, weight: Number }],
  source: { type: String, enum: ['realtime', 'analyzer'], default: 'realtime' },
  auto_action: String, // e.g. 'blacklist:device:permanent'
  created_at: { type: Date, default: Date.now },
});

fraudDetectionSchema.index({ created_at: -1 });
fraudDetectionSchema.index({ action: 1, created_at: -1 });
fraudDetectionSchema.index({ stage: 1, created_at: -1 });
fraudDetectionSchema.index({ 'subject.deviceFp': 1, created_at: -1 });
fraudDetectionSchema.index({ 'subject.ip': 1, created_at: -1 });
// Retention TTL: 90 days.
fraudDetectionSchema.index({ created_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('FraudDetection', fraudDetectionSchema);
