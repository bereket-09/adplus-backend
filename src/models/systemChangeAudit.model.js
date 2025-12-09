// models/systemChangeAudit.model.js
const mongoose = require('mongoose');

const systemChangeAuditSchema = new mongoose.Schema({
  entity_type: { type: String, required: true }, // e.g., 'ad', 'marketer'
  entity_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  action: { type: String, required: true }, // e.g., 'create', 'update', 'approve'
  changed_fields: { type: Object }, // { fieldName: { old: value, new: value } }
  performed_by: { type: String }, // optional: admin id/email
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SystemChangeAudit', systemChangeAuditSchema);
