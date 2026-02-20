const mongoose = require('mongoose');

const marketerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true }, // added
  password: { type: String }, // hashed password
  total_budget: { type: Number, default: 0 },
  remaining_budget: { type: Number, default: 0 },
  contact_info: { type: String },
  company_name: { type: String },
  business_reg_number: { type: String },
  business_address: { type: String },
  kyc_info: { type: mongoose.Schema.Types.Mixed },
  status: {
    type: String,
    enum: ['active', 'pending', 'pendingPassChange', 'deactivated', 'inactive', 'rejected'],
    default: 'pending'
  },
  created_at: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Marketer', marketerSchema);
