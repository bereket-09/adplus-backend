const Marketer = require('../models/marketer.model');
const MarketerTransaction = require('../models/marketerTransaction.model');
const logger = require('../utils/logger'); // <-- import logger

exports.topUp = async (req, res, next) => {
    try {
        const { marketerId, amount, payment_method, description } = req.body;
        logger.info(`MarketerController.topUp - Attempting top-up for marketer ${marketerId}, amount ${amount}`);

        if (!marketerId || !amount) {
            logger.error(`MarketerController.topUp - Missing marketerId or amount`);
            return res.status(400).json({ status: false, error: 'marketerId and amount required' });
        }

        const marketer = await Marketer.findById(marketerId);
        if (!marketer) {
            logger.error(`MarketerController.topUp - Marketer ${marketerId} not found`);
            return res.status(404).json({ status: false, error: 'marketer not found' });
        }

        const previous_budget = marketer.remaining_budget;
        marketer.remaining_budget += amount;
        marketer.total_budget += amount;
        await marketer.save();

        const transaction = await MarketerTransaction.create({
            marketer_id: marketer._id,
            type: 'topup',
            amount,
            previous_budget,
            new_budget: marketer.remaining_budget,
            payment_method,
            description
        });

        logger.info(`MarketerController.topUp - Top-up successful for marketer ${marketerId}, transaction ${transaction._id}`);

        res.json({ status: true, message: 'Top-up successful', marketer, transaction });
    } catch (err) {
        logger.error(`MarketerController.topUp - Error during top-up: ${err.message}`);
        next(err);
    }
};

exports.deduct = async (req, res, next) => {
    try {
        const { marketerId, amount, reason, description } = req.body;
        logger.info(`MarketerController.deduct - Attempting deduction for marketer ${marketerId}, amount ${amount}, reason ${reason}`);

        if (!marketerId || !amount || !reason) {
            logger.error(`MarketerController.deduct - Missing marketerId, amount, or reason`);
            return res.status(400).json({ status: false, error: 'marketerId, amount, and reason required' });
        }

        const marketer = await Marketer.findById(marketerId);
        if (!marketer) {
            logger.error(`MarketerController.deduct - Marketer ${marketerId} not found`);
            return res.status(404).json({ status: false, error: 'marketer not found' });
        }

        const previous_budget = marketer.remaining_budget;
        marketer.remaining_budget = Math.max(0, marketer.remaining_budget - amount);
        await marketer.save();

        const transaction = await MarketerTransaction.create({
            marketer_id: marketer._id,
            type: 'deduction',
            amount,
            previous_budget,
            new_budget: marketer.remaining_budget,
            reason,
            description
        });

        logger.info(`MarketerController.deduct - Deduction successful for marketer ${marketerId}, transaction ${transaction._id}`);

        res.json({ status: true, message: 'Deduction successful', marketer, transaction });
    } catch (err) {
        logger.error(`MarketerController.deduct - Error during deduction: ${err.message}`);
        next(err);
    }
};

// ✅ New method: fetch transaction logs
exports.getTransactions = async (req, res, next) => {
    try {
        const { marketerId } = req.params;
        const { type, startDate, endDate } = req.query;

        logger.info(`MarketerController.getTransactions - Fetching transactions for marketer ${marketerId}, type: ${type || 'all'}, startDate: ${startDate || 'none'}, endDate: ${endDate || 'none'}`);

        if (!marketerId) {
            logger.error(`MarketerController.getTransactions - Missing marketerId`);
            return res.status(400).json({ status: false, error: 'marketerId required' });
        }

        const query = { marketer_id: marketerId };
        if (type) query.type = type;
        if (startDate || endDate) query.created_at = {};
        if (startDate) query.created_at.$gte = new Date(startDate);
        if (endDate) query.created_at.$lte = new Date(endDate);

        const transactions = await MarketerTransaction.find(query).sort({ created_at: -1 });

        logger.debug(`MarketerController.getTransactions - Returned ${transactions.length} transactions for marketer ${marketerId}`);

        res.json({ status: true, transactions });
    } catch (err) {
        logger.error(`MarketerController.getTransactions - Error fetching transactions: ${err.message}`);
        next(err);
    }
};
