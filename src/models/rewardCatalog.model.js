const mongoose = require('mongoose');

const rewardCatalogSchema = new mongoose.Schema({
    name: { type: String, required: true },              // internal name
    display_label: { type: String, required: true },     // shown to end users, e.g. "500MB Data Bundle"
    type: {
        type: String,
        enum: ['data', 'airtime', 'voucher', 'other'],
        required: true
    },
    value: { type: Number, required: true },             // numeric value, e.g. 500
    unit: { type: String, default: '' },                 // e.g. "MB", "GB", "ETB"
    etc_product_code: { type: String, default: '' },     // maps to a real ETC bundle code (optional)
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

rewardCatalogSchema.index({ active: 1 });

module.exports = mongoose.model('RewardCatalog', rewardCatalogSchema);
