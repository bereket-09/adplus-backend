const BillingModel = require('../models/billingModel.model');
const logger = require('../utils/logger');

exports.list = async (req, res, next) => {
    try {
        const models = await BillingModel.find({ active: true });
        res.json({ status: true, models });
    } catch (err) {
        logger.error(`BillingModelController.list - Error: ${err.message}`);
        next(err);
    }
};

exports.get = async (req, res, next) => {
    try {
        const model = await BillingModel.findById(req.params.id);
        if (!model) return res.status(404).json({ status: false, message: "Model not found" });
        res.json({ status: true, model });
    } catch (err) {
        logger.error(`BillingModelController.get - Error: ${err.message}`);
        next(err);
    }
};

exports.create = async (req, res, next) => {
    try {
        const { name, slug, description, cpv_rate, cpc_rate, features } = req.body;
        logger.info(`BillingModelController.create - Creating: ${name} (${slug})`);

        const model = await BillingModel.create({
            name,
            slug: slug || name.toLowerCase().replace(/ /g, '_'),
            description,
            cpv_rate,
            cpc_rate,
            features,
            created_at: new Date()
        });

        res.json({ status: true, model });
    } catch (err) {
        logger.error(`BillingModelController.create - Error: ${err.message}`);
        next(err);
    }
};

exports.update = async (req, res, next) => {
    try {
        const model = await BillingModel.findByIdAndUpdate(
            req.params.id,
            { ...req.body, updated_at: new Date() },
            { new: true }
        );
        if (!model) return res.status(404).json({ status: false, message: "Model not found" });
        res.json({ status: true, model });
    } catch (err) {
        logger.error(`BillingModelController.update - Error: ${err.message}`);
        next(err);
    }
};

exports.delete = async (req, res, next) => {
    try {
        const model = await BillingModel.findByIdAndUpdate(req.params.id, { active: false });
        if (!model) return res.status(404).json({ status: false, message: "Model not found" });
        res.json({ status: true, message: "Model deactivated" });
    } catch (err) {
        logger.error(`BillingModelController.delete - Error: ${err.message}`);
        next(err);
    }
};
