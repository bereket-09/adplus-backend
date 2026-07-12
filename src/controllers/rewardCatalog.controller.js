const RewardCatalog = require('../models/rewardCatalog.model');
const logger = require('../utils/logger');

const ALLOWED_TYPES = ['data', 'airtime', 'voucher', 'other'];

// GET /reward-catalog  (public) - active rewards only
exports.listPublic = async (req, res, next) => {
    try {
        const rewards = await RewardCatalog.find({ active: true })
            .select('name display_label type value unit etc_product_code description active created_at')
            .sort({ created_at: -1 })
            .limit(200)
            .lean();
        res.json({ status: true, rewards });
    } catch (err) {
        logger.error(`RewardCatalogController.listPublic - Error: ${err.message}`);
        next(err);
    }
};

// GET /reward-catalog/admin  (admin) - all rewards
exports.listAdmin = async (req, res, next) => {
    try {
        const { active } = req.query;
        const query = {};
        if (active === 'true') query.active = true;
        if (active === 'false') query.active = false;

        const rewards = await RewardCatalog.find(query)
            .select('name display_label type value unit etc_product_code description active created_at updated_at')
            .sort({ created_at: -1 })
            .limit(500)
            .lean();
        res.json({ status: true, rewards });
    } catch (err) {
        logger.error(`RewardCatalogController.listAdmin - Error: ${err.message}`);
        next(err);
    }
};

// GET /reward-catalog/:id  (public)
exports.get = async (req, res, next) => {
    try {
        const reward = await RewardCatalog.findById(req.params.id)
            .select('name display_label type value unit etc_product_code description active created_at updated_at')
            .lean();
        if (!reward) return res.status(404).json({ status: false, error: 'Reward not found' });
        res.json({ status: true, reward });
    } catch (err) {
        logger.error(`RewardCatalogController.get - Error: ${err.message}`);
        next(err);
    }
};

// POST /reward-catalog  (admin)
exports.create = async (req, res, next) => {
    try {
        const { name, display_label, type, value, unit, etc_product_code, description, active } = req.body;

        if (!name || !display_label) {
            return res.status(400).json({ status: false, error: 'name and display_label are required' });
        }
        if (!ALLOWED_TYPES.includes(type)) {
            return res.status(400).json({ status: false, error: `type must be one of: ${ALLOWED_TYPES.join(', ')}` });
        }
        if (value === undefined || value === null || isNaN(Number(value))) {
            return res.status(400).json({ status: false, error: 'value must be a number' });
        }

        logger.info(`RewardCatalogController.create - Creating: ${name} (${type})`);

        const reward = await RewardCatalog.create({
            name,
            display_label,
            type,
            value: Number(value),
            unit: unit || '',
            etc_product_code: etc_product_code || '',
            description: description || '',
            active: active !== undefined ? !!active : true,
            created_at: new Date(),
            updated_at: new Date()
        });

        res.json({ status: true, reward });
    } catch (err) {
        logger.error(`RewardCatalogController.create - Error: ${err.message}`);
        next(err);
    }
};

// PUT /reward-catalog/:id  (admin)
exports.update = async (req, res, next) => {
    try {
        const { name, display_label, type, value, unit, etc_product_code, description, active } = req.body;
        const update = { updated_at: new Date() };

        if (name !== undefined) update.name = name;
        if (display_label !== undefined) update.display_label = display_label;
        if (type !== undefined) {
            if (!ALLOWED_TYPES.includes(type)) {
                return res.status(400).json({ status: false, error: `type must be one of: ${ALLOWED_TYPES.join(', ')}` });
            }
            update.type = type;
        }
        if (value !== undefined) {
            if (value === null || isNaN(Number(value))) {
                return res.status(400).json({ status: false, error: 'value must be a number' });
            }
            update.value = Number(value);
        }
        if (unit !== undefined) update.unit = unit;
        if (etc_product_code !== undefined) update.etc_product_code = etc_product_code;
        if (description !== undefined) update.description = description;
        if (active !== undefined) update.active = !!active;

        const reward = await RewardCatalog.findByIdAndUpdate(
            req.params.id,
            update,
            { new: true }
        );
        if (!reward) return res.status(404).json({ status: false, error: 'Reward not found' });
        res.json({ status: true, reward });
    } catch (err) {
        logger.error(`RewardCatalogController.update - Error: ${err.message}`);
        next(err);
    }
};

// POST /reward-catalog/:id/toggle  (admin)
exports.toggle = async (req, res, next) => {
    try {
        const reward = await RewardCatalog.findById(req.params.id).select('active');
        if (!reward) return res.status(404).json({ status: false, error: 'Reward not found' });

        reward.active = !reward.active;
        reward.updated_at = new Date();
        await reward.save();

        res.json({ status: true, reward });
    } catch (err) {
        logger.error(`RewardCatalogController.toggle - Error: ${err.message}`);
        next(err);
    }
};

// DELETE /reward-catalog/:id  (admin)
exports.delete = async (req, res, next) => {
    try {
        const reward = await RewardCatalog.findByIdAndDelete(req.params.id);
        if (!reward) return res.status(404).json({ status: false, error: 'Reward not found' });
        res.json({ status: true, message: 'Reward deleted' });
    } catch (err) {
        logger.error(`RewardCatalogController.delete - Error: ${err.message}`);
        next(err);
    }
};
