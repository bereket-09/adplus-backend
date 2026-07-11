const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
  type: String,
  msisdn: String,
  token: String,
  ad_id: mongoose.Schema.Types.ObjectId,
  marketer_id: mongoose.Schema.Types.ObjectId,
  timestamp: { type: Date, default: Date.now },
  ip: String,
  user_agent: String,
  device_info: Object,
  location: Object,
  request_payload: Object,
  fraud_detected: { type: Boolean, default:false }
});

// Indexes — this collection previously had NONE and grows into the millions.
auditSchema.index({ ad_id: 1, type: 1, timestamp: -1 }); // per-ad event counts (e.g. sms_sent)
auditSchema.index({ msisdn: 1, timestamp: -1 });         // per-subscriber history
auditSchema.index({ type: 1, timestamp: -1 });           // filtered event feeds
// Retention TTL: auto-expire raw audit rows after 90 days to bound growth.
// NOTE: this DELETES audit data after 90d — widen (or move to archival) if a
// longer compliance retention is required.
auditSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('AuditLog', auditSchema);
