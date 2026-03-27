const mongoose = require('mongoose');

const billingModelSchema = new mongoose.Schema({
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true }, // e.g. 'standard', 'engagement_plus'
    description: String,
    cpv_rate: { type: Number, default: 0 },
    cpc_rate: { type: Number, default: 0 },
    features: {
        has_video: { type: Boolean, default: true },
        has_banner: { type: Boolean, default: false },
        has_cta: { type: Boolean, default: false },
        require_focus: { type: Boolean, default: true }
    },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BillingModel', billingModelSchema);
