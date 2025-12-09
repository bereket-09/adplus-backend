const mongoose = require('mongoose');
const AuditLog = require('./audit.model');

const watchLinkSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  msisdn: { type: String, required: true },
  ad_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  marketer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marketer', required: true },
  status: { type: String, enum:['pending','opened','started','completed','expired'], default:'pending' },
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, default: () => new Date(Date.now() + 1000*60*60*3) }, // 3 hours TTL
  opened_at: Date,
  started_at: Date,
  completed_at: Date,
  secure_key: String, // NEW: unique security key per watch
  ip: String,
  user_agent: String,
  device_info: Object,
  location: Object,
  meta_json: Object,
  fraud_flags: [Object]
});

// TTL Index
watchLinkSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

watchLinkSchema.methods.addAudit = async function(type, fraud=false, details=null){
  await AuditLog.create({
    type,
    msisdn: this.msisdn,
    token: this.token,
    ad_id: this.ad_id,
    marketer_id: this.marketer_id,
    timestamp: new Date(),
    fraud_detected: fraud,
    request_payload: details
  });
};

watchLinkSchema.methods.addFraud = function(reason, data){
  this.fraud_flags.push({ reason, data, timestamp: new Date() });
  return this.save();
};

watchLinkSchema.methods.detectChange = function({ ip, userAgent, location }){
  if (this.ip && this.ip !== ip) return true;
  if (this.user_agent && this.user_agent !== userAgent) return true;
  return false;
};

module.exports = mongoose.model('WatchLink', watchLinkSchema);
