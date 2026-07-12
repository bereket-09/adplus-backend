const mongoose = require('mongoose');
const Notification = require('../models/notification.model');
const logger = require('../utils/logger');

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function parseLimit(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Helper other code can call to emit a notification.
 * Fire-and-forget friendly; returns the created lean-ish document.
 * createNotification({ user_id, role, type, title, body, data })
 */
exports.createNotification = async function createNotification({ user_id, role, type, title, body, data } = {}) {
  if (!user_id) throw new Error('createNotification: user_id is required');
  const doc = await Notification.create({
    user_id: String(user_id),
    role,
    type,
    title,
    body,
    data: data || {},
    read: false,
    created_at: new Date()
  });
  return doc;
};

/**
 * LIST notifications for the authenticated user.
 * Keyset paginated by created_at (descending).
 * GET /api/v1/notifications?limit=20&before=<ISO created_at cursor>
 */
exports.list = async (req, res, next) => {
  try {
    const userId = String(req.user.id);
    const limit = parseLimit(req.query.limit);

    const filter = { user_id: userId };

    // Keyset cursor: fetch items strictly older than `before`.
    if (req.query.before) {
      const cursor = new Date(req.query.before);
      if (!Number.isNaN(cursor.getTime())) {
        filter.created_at = { $lt: cursor };
      }
    }

    // Fetch one extra to determine if there's a next page.
    const rows = await Notification.find(filter)
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .select('user_id role type title body data read created_at')
      .lean();

    const hasMore = rows.length > limit;
    const notifications = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? notifications[notifications.length - 1].created_at.toISOString()
      : null;

    res.json({
      status: true,
      notifications,
      pagination: { limit, has_more: hasMore, next_cursor: nextCursor }
    });
  } catch (err) {
    logger.error(`NotificationController.list - ${err.message}`);
    next(err);
  }
};

/**
 * Unread count for the authenticated user.
 * GET /api/v1/notifications/unread-count
 */
exports.unreadCount = async (req, res, next) => {
  try {
    const userId = String(req.user.id);
    const count = await Notification.countDocuments({ user_id: userId, read: false });
    res.json({ status: true, unread_count: count });
  } catch (err) {
    logger.error(`NotificationController.unreadCount - ${err.message}`);
    next(err);
  }
};

/**
 * Mark a single notification read (scoped to the authenticated user).
 * POST /api/v1/notifications/:id/read
 */
exports.markRead = async (req, res, next) => {
  try {
    const userId = String(req.user.id);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: false, error: 'Invalid notification id' });
    }

    const result = await Notification.updateOne(
      { _id: id, user_id: userId },
      { $set: { read: true } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ status: false, error: 'Notification not found' });
    }

    res.json({ status: true });
  } catch (err) {
    logger.error(`NotificationController.markRead - ${err.message}`);
    next(err);
  }
};

/**
 * Mark all of the authenticated user's notifications read.
 * POST /api/v1/notifications/read-all
 */
exports.markAllRead = async (req, res, next) => {
  try {
    const userId = String(req.user.id);
    const result = await Notification.updateMany(
      { user_id: userId, read: false },
      { $set: { read: true } }
    );
    res.json({ status: true, modified: result.modifiedCount || 0 });
  } catch (err) {
    logger.error(`NotificationController.markAllRead - ${err.message}`);
    next(err);
  }
};
