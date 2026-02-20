const Blacklist = require('../models/blacklist.model');
const { invalidateCache } = require('../utils/blacklistCheck');
const logger = require('../utils/logger');

/**
 * LIST all blacklist entries (with filtering)
 * GET /api/v1/blacklist?type=msisdn&is_active=true&page=1&limit=50
 */
exports.list = async (req, res, next) => {
    try {
        const { type, is_active, severity, page = 1, limit = 50, search } = req.query;
        const filter = {};

        if (type) filter.type = type;
        if (is_active !== undefined) filter.is_active = is_active === 'true';
        if (severity) filter.severity = severity;
        if (search) filter.value = { $regex: search, $options: 'i' };

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [entries, total] = await Promise.all([
            Blacklist.find(filter).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Blacklist.countDocuments(filter)
        ]);

        res.json({
            status: true,
            entries,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        logger.error(`BlacklistController.list - ${err.message}`);
        next(err);
    }
};

/**
 * ADD to blacklist
 * POST /api/v1/blacklist
 * Body: { type, value, reason, severity, blocked_by, notes, expires_at }
 */
exports.add = async (req, res, next) => {
    try {
        const { type, value, reason, severity, blocked_by, notes, expires_at } = req.body;

        if (!type || !value) {
            return res.status(400).json({ status: false, error: 'type and value are required' });
        }

        // Check if already exists
        const existing = await Blacklist.findOne({ type, value });
        if (existing) {
            // Reactivate if it was disabled
            existing.is_active = true;
            existing.reason = reason || existing.reason;
            existing.severity = severity || existing.severity;
            existing.blocked_by = blocked_by || existing.blocked_by;
            existing.notes = notes || existing.notes;
            existing.expires_at = expires_at || existing.expires_at;
            existing.updated_at = new Date();
            await existing.save();

            invalidateCache();
            return res.json({ status: true, entry: existing, action: 'reactivated' });
        }

        const entry = await Blacklist.create({
            type,
            value,
            reason: reason || 'manual',
            severity: severity || 'block',
            blocked_by: blocked_by || 'admin',
            notes,
            expires_at: expires_at || null
        });

        invalidateCache();

        logger.info(`Blacklist entry added: ${type}=${value} by ${blocked_by || 'admin'}`);
        res.json({ status: true, entry, action: 'created' });
    } catch (err) {
        logger.error(`BlacklistController.add - ${err.message}`);
        next(err);
    }
};

/**
 * REMOVE from blacklist (soft deactivate)
 * DELETE /api/v1/blacklist/:id
 */
exports.remove = async (req, res, next) => {
    try {
        const { id } = req.params;
        const entry = await Blacklist.findById(id);
        if (!entry) return res.status(404).json({ status: false, error: 'Entry not found' });

        entry.is_active = false;
        entry.updated_at = new Date();
        await entry.save();

        invalidateCache();

        logger.info(`Blacklist entry deactivated: ${entry.type}=${entry.value}`);
        res.json({ status: true, entry });
    } catch (err) {
        logger.error(`BlacklistController.remove - ${err.message}`);
        next(err);
    }
};

/**
 * HARD DELETE 
 * DELETE /api/v1/blacklist/:id/permanent
 */
exports.permanentDelete = async (req, res, next) => {
    try {
        const { id } = req.params;
        const entry = await Blacklist.findByIdAndDelete(id);
        if (!entry) return res.status(404).json({ status: false, error: 'Entry not found' });

        invalidateCache();

        logger.info(`Blacklist entry permanently deleted: ${entry.type}=${entry.value}`);
        res.json({ status: true, deleted: true });
    } catch (err) {
        logger.error(`BlacklistController.permanentDelete - ${err.message}`);
        next(err);
    }
};

/**
 * UPDATE blacklist entry
 * PUT /api/v1/blacklist/:id
 */
exports.update = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { severity, reason, notes, is_active, expires_at } = req.body;

        const entry = await Blacklist.findById(id);
        if (!entry) return res.status(404).json({ status: false, error: 'Entry not found' });

        if (severity) entry.severity = severity;
        if (reason) entry.reason = reason;
        if (notes !== undefined) entry.notes = notes;
        if (is_active !== undefined) entry.is_active = is_active;
        if (expires_at !== undefined) entry.expires_at = expires_at;
        entry.updated_at = new Date();

        await entry.save();
        invalidateCache();

        res.json({ status: true, entry });
    } catch (err) {
        logger.error(`BlacklistController.update - ${err.message}`);
        next(err);
    }
};

/**
 * STATS summary
 * GET /api/v1/blacklist/stats
 */
exports.stats = async (req, res, next) => {
    try {
        const [totalActive, totalInactive, byType, bySeverity, topHit] = await Promise.all([
            Blacklist.countDocuments({ is_active: true }),
            Blacklist.countDocuments({ is_active: false }),
            Blacklist.aggregate([
                { $match: { is_active: true } },
                { $group: { _id: '$type', count: { $sum: 1 } } }
            ]),
            Blacklist.aggregate([
                { $match: { is_active: true } },
                { $group: { _id: '$severity', count: { $sum: 1 } } }
            ]),
            Blacklist.find({ is_active: true }).sort({ hit_count: -1 }).limit(10).lean()
        ]);

        res.json({
            status: true,
            stats: {
                total_active: totalActive,
                total_inactive: totalInactive,
                by_type: byType.reduce((acc, b) => { acc[b._id] = b.count; return acc; }, {}),
                by_severity: bySeverity.reduce((acc, b) => { acc[b._id] = b.count; return acc; }, {}),
                top_triggered: topHit.map(e => ({
                    type: e.type,
                    value: e.value,
                    hit_count: e.hit_count,
                    severity: e.severity,
                    last_hit_at: e.last_hit_at
                }))
            }
        });
    } catch (err) {
        logger.error(`BlacklistController.stats - ${err.message}`);
        next(err);
    }
};

/**
 * BULK add to blacklist
 * POST /api/v1/blacklist/bulk
 * Body: { entries: [{ type, value, reason, severity }], blocked_by }
 */
exports.bulkAdd = async (req, res, next) => {
    try {
        const { entries, blocked_by } = req.body;

        if (!entries || !Array.isArray(entries) || entries.length === 0) {
            return res.status(400).json({ status: false, error: 'entries array required' });
        }

        if (entries.length > 500) {
            return res.status(400).json({ status: false, error: 'Maximum 500 entries per bulk operation' });
        }

        const results = { created: 0, reactivated: 0, failed: 0 };

        for (const item of entries) {
            try {
                const existing = await Blacklist.findOne({ type: item.type, value: item.value });
                if (existing) {
                    existing.is_active = true;
                    existing.reason = item.reason || existing.reason;
                    existing.severity = item.severity || existing.severity;
                    existing.updated_at = new Date();
                    await existing.save();
                    results.reactivated++;
                } else {
                    await Blacklist.create({
                        type: item.type,
                        value: item.value,
                        reason: item.reason || 'bulk_import',
                        severity: item.severity || 'block',
                        blocked_by: blocked_by || 'admin'
                    });
                    results.created++;
                }
            } catch {
                results.failed++;
            }
        }

        invalidateCache();

        res.json({ status: true, results });
    } catch (err) {
        logger.error(`BlacklistController.bulkAdd - ${err.message}`);
        next(err);
    }
};
