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

module.exports = mongoose.model('AuditLog', auditSchema);
