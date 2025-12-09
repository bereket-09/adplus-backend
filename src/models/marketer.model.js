const mongoose = require('mongoose');

const marketerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true }, // added
  password: { type: String }, // hashed password
  total_budget: { type: Number, required: true },
  remaining_budget: { type: Number, required: true },
  contact_info: { type: String },
  status: { type: String, enum: ['active', 'pendingPassChange', 'deactivated', 'inactive'], default: 'pendingPassChange' },
  created_at: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Marketer', marketerSchema);
