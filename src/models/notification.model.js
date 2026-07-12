const mongoose = require('mongoose');

/**
 * Notification
 * Recipient is identified by user_id — a string holding the id of a
 * Marketer or an admin User. Stored as a String (not ObjectId ref) so a
 * single collection can serve both actor types uniformly.
 */
const notificationSchema = new mongoose.Schema({
  user_id: { type: String, required: true }, // marketer or admin id (string)
  role: { type: String },                    // 'marketer' | 'admin' (recipient role)
  type: { type: String },                    // app-defined category, e.g. 'budget_low'
  title: { type: String },
  body: { type: String },
  data: { type: Object, default: {} },       // arbitrary structured payload
  read: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

// Keyset pagination by created_at, scoped per recipient.
notificationSchema.index({ user_id: 1, created_at: -1 });
// Unread-count / read-filter, scoped per recipient.
notificationSchema.index({ user_id: 1, read: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
