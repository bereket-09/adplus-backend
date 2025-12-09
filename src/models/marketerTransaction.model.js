const mongoose = require('mongoose');

const marketerTransactionSchema = new mongoose.Schema({
  marketer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marketer', required: true },
  type: { type: String, enum: ['topup', 'deduction'], required: true },
  amount: { type: Number, required: true },
  previous_budget: { type: Number, required: true },
  new_budget: { type: Number, required: true },
  payment_method: { type: String }, // optional, for top-up
  reason: { type: String }, // optional, for deduction
  description: { type: String },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MarketerTransaction', marketerTransactionSchema);
