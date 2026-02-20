const mongoose = require('mongoose');

const blacklistSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['msisdn', 'ip', 'device', 'user_agent'],
        required: true
    },
    value: { type: String, required: true }, // the actual MSISDN, IP, device fingerprint, etc.
    reason: { type: String, default: 'manual' }, // e.g. 'fraud', 'abuse', 'manual', 'auto_detected'
    severity: { type: String, enum: ['warn', 'block', 'permanent'], default: 'block' },
    blocked_by: { type: String, default: 'system' }, // admin user or 'system'
    notes: String,
    is_active: { type: Boolean, default: true },
    expires_at: { type: Date, default: null }, // null = permanent
    hit_count: { type: Number, default: 0 }, // how many times this entry was triggered
    last_hit_at: Date,
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

// Compound index for fast lookups
blacklistSchema.index({ type: 1, value: 1 }, { unique: true });
blacklistSchema.index({ is_active: 1, type: 1 });

// Auto-expire entries with expires_at set
blacklistSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Blacklist', blacklistSchema);
