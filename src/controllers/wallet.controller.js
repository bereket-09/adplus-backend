const mongoose = require('mongoose');
const Marketer = require('../models/marketer.model');
const MarketerTransaction = require('../models/marketerTransaction.model');
const logger = require('../utils/logger');

// The WALLET maps directly onto the marketer budget:
//   total_budget     => lifetime credited (topups) / wallet capacity
//   remaining_budget => spendable balance
//   spent            => total_budget - remaining_budget (derived)
// All balance mutations MUST be atomic ($inc via findOneAndUpdate) — never
// read-modify-write — because ad-serving deductions run concurrently at scale.

const DEFAULT_TX_LIMIT = 20;
const MAX_TX_LIMIT = 100;

// GET /wallet/balance
// Returns the current wallet snapshot for the authenticated marketer.
exports.getBalance = async (req, res, next) => {
    try {
        const marketerId = req.user.id;

        const marketer = await Marketer.findById(marketerId)
            .select('total_budget remaining_budget')
            .lean();

        if (!marketer) {
            logger.error(`WalletController.getBalance - Marketer ${marketerId} not found`);
            return res.status(404).json({ status: false, error: 'marketer not found' });
        }

        const total_budget = marketer.total_budget || 0;
        const remaining_budget = marketer.remaining_budget || 0;
        const spent = Math.max(0, total_budget - remaining_budget);

        return res.json({ status: true, total_budget, remaining_budget, spent });
    } catch (err) {
        logger.error(`WalletController.getBalance - Error: ${err.message}`);
        next(err);
    }
};

// GET /wallet/transactions
// Keyset (cursor) pagination by created_at DESC. Pass ?cursor=<ISO date of the
// last item from the previous page> to fetch older records. Time-bounded via the
// cursor, projected, .lean() and .limit() so we never scan the whole collection.
// Uses the {marketer_id, created_at} index.
exports.getTransactions = async (req, res, next) => {
    try {
        const marketerId = req.user.id;

        let limit = parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_TX_LIMIT;
        if (limit > MAX_TX_LIMIT) limit = MAX_TX_LIMIT;

        const query = { marketer_id: marketerId };

        // Keyset cursor: strictly older than the last seen created_at.
        if (req.query.cursor) {
            const cursorDate = new Date(req.query.cursor);
            if (isNaN(cursorDate.getTime())) {
                return res.status(400).json({ status: false, error: 'invalid cursor' });
            }
            query.created_at = { $lt: cursorDate };
        }

        const transactions = await MarketerTransaction.find(query)
            .select('type amount previous_budget new_budget payment_method reason description created_at')
            .sort({ created_at: -1 })
            .limit(limit)
            .lean();

        // Next cursor = created_at of the last row; null when the page is not full.
        const next_cursor = transactions.length === limit
            ? transactions[transactions.length - 1].created_at
            : null;

        return res.json({ status: true, transactions, next_cursor });
    } catch (err) {
        logger.error(`WalletController.getTransactions - Error: ${err.message}`);
        next(err);
    }
};

// POST /wallet/topup  { amount, payment_method }
// NOTE: There is NO real payment gateway integrated yet. We treat this request as
// an already-authorized ledger credit (the money is assumed collected upstream)
// and simply record it. When a gateway is added, the charge must be confirmed
// BEFORE this credit is applied.
exports.topUp = async (req, res, next) => {
    try {
        const marketerId = req.user.id;
        const { amount, payment_method } = req.body;

        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
            logger.error(`WalletController.topUp - Invalid amount for marketer ${marketerId}: ${amount}`);
            return res.status(400).json({ status: false, error: 'amount must be a positive number' });
        }

        // Atomic credit: $inc both fields in a single findOneAndUpdate. Returns the
        // post-increment document so we can derive previous_budget without a race.
        const updated = await Marketer.findOneAndUpdate(
            { _id: marketerId },
            { $inc: { remaining_budget: amt, total_budget: amt } },
            { new: true, projection: { total_budget: 1, remaining_budget: 1 } }
        ).lean();

        if (!updated) {
            logger.error(`WalletController.topUp - Marketer ${marketerId} not found`);
            return res.status(404).json({ status: false, error: 'marketer not found' });
        }

        const new_budget = updated.remaining_budget;
        const previous_budget = new_budget - amt;

        await MarketerTransaction.create({
            marketer_id: marketerId,
            type: 'topup',
            amount: amt,
            previous_budget,
            new_budget,
            payment_method,
            description: 'Wallet top-up (authorized ledger credit; no gateway settlement yet)'
        });

        logger.info(`WalletController.topUp - Credited ${amt} to marketer ${marketerId}; new remaining_budget ${new_budget}`);

        const total_budget = updated.total_budget || 0;
        const remaining_budget = updated.remaining_budget || 0;
        const spent = Math.max(0, total_budget - remaining_budget);

        return res.json({ status: true, total_budget, remaining_budget, spent });
    } catch (err) {
        logger.error(`WalletController.topUp - Error: ${err.message}`);
        next(err);
    }
};
