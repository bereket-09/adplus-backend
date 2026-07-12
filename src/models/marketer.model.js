const mongoose = require('mongoose');

const marketerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String }, // hashed password
  total_budget: { type: Number, default: 0 },
  remaining_budget: { type: Number, default: 0 },
  contact_info: { type: String },
  company_name: { type: String },
  business_reg_number: { type: String },
  business_address: { type: String },
  business_category: { type: String },
  contact_person: {
    name: String,
    phone: String,
    position: String
  },
  kyc_documents: [{
    doc_type: String, // e.g. 'Business License', 'Tax ID'
    file_url: String,
    file_name: String,
    uploaded_at: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    feedback: String
  }],
  kyc_status: {
    type: String,
    enum: ['unverified', 'pending', 'verified', 'rejected'],
    default: 'unverified'
  },
  status: {
    type: String,
    enum: ['active', 'pending', 'pendingPassChange', 'deactivated', 'inactive', 'rejected'],
    default: 'pending'
  },
  admin_comments: String,
  created_at: { type: Date, default: Date.now }
});

marketerSchema.index({ created_at: -1 }); // admin marketer-list keyset pagination

module.exports = mongoose.model('Marketer', marketerSchema);
