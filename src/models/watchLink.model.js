const mongoose = require('mongoose');
const AuditLog = require('./audit.model');

const watchLinkSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  msisdn: { type: String, required: true },
  ad_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  marketer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marketer', required: true },
  status: { type: String, enum: ['pending', 'opened', 'started', 'completed', 'expired'], default: 'pending' },
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, default: () => new Date(Date.now() + 1000 * 60 * 60 * 3) }, // 3h watch validity
  // Mongo purges the document at purge_at (NOT expires_at) so the reservation
  // sweeper has a window to release unspent budget before the row disappears.
  purge_at: { type: Date, default: () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 7) }, // 7d

  // ---- Budget reservation lifecycle ----
  // reserved  : budget held at SMS-send, awaiting completion/expiry
  // committed : viewer completed → durable spend recorded
  // released  : link expired unwatched → budget returned to the campaign
  budget_state: { type: String, enum: ['none', 'reserved', 'committed', 'released'], default: 'none' },
  reserved_amount: { type: Number, default: 0 }, // ETB held for this link
  trigger_source: { type: String, default: 'ocs' }, // ocs | manual | simulator

  // ---- Reward outcome ----
  reward_granted: { type: Boolean, default: false },
  reward_status: { type: String, enum: ['granted', 'pending', 'failed'], default: 'pending' },
  reward_offer_id: String,
  reward_record_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Reward' },
  reward_provider_ref: String,

  opened_at: Date,
  started_at: Date,
  completed_at: Date,
  secure_key: String, // NEW: unique security key per watch
  ip: String,
  user_agent: String,
  device_info: Object,
  location: Object,
  meta_json: Object,
  fraud_flags: [Object],
  last_position: { type: Number, default: 0 },
  max_position_reached: { type: Number, default: 0 },
  drop_off_point: { type: Number },
  clicked: { type: Boolean, default: false },
  clicked_at: { type: Date },
  clicked_charged: { type: Boolean, default: false },
  has_fraud: { type: Boolean, default: false } // set when any fraud signal flags this watch
});

// TTL Index — delete at purge_at (7d), giving the reservation sweeper time to
// reclaim unspent budget from links that expired (3h) without completing.
watchLinkSchema.index({ purge_at: 1 }, { expireAfterSeconds: 0 });
// Sweeper + resend lookups.
watchLinkSchema.index({ budget_state: 1, status: 1, expires_at: 1 });
watchLinkSchema.index({ msisdn: 1, status: 1, expires_at: 1 });
// Analytics / reporting access paths (previously unindexed → collection scans).
watchLinkSchema.index({ ad_id: 1, created_at: -1 });
watchLinkSchema.index({ marketer_id: 1, created_at: -1 });
watchLinkSchema.index({ status: 1, created_at: -1 });
watchLinkSchema.index({ ad_id: 1, status: 1 });
// Tiny partial index — only flagged watches — for the fraud dashboard.
watchLinkSchema.index({ has_fraud: 1, created_at: -1 }, { partialFilterExpression: { has_fraud: true } });

watchLinkSchema.methods.addAudit = async function (type, fraud = false, details = null) {
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

watchLinkSchema.methods.addFraud = function (reason, data) {
  this.fraud_flags.push({ reason, data, timestamp: new Date() });
  return this.save();
};

watchLinkSchema.methods.detectChange = function ({ ip, userAgent, location }) {
  if (this.ip && this.ip !== ip) return true;
  if (this.user_agent && this.user_agent !== userAgent) return true;
  return false;
};

module.exports = mongoose.model('WatchLink', watchLinkSchema);
