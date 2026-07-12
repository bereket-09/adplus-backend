const express = require('express');
const router = express.Router();
const NotificationController = require('../../controllers/notification.controller');

// NOTE: verifyToken is applied globally in index.js before this router is
// mounted, so req.user is guaranteed here. All handlers scope to req.user.id.

// GET /api/v1/notifications  (keyset paginated by created_at)
router.get('/', NotificationController.list);

// GET /api/v1/notifications/unread-count
router.get('/unread-count', NotificationController.unreadCount);

// POST /api/v1/notifications/:id/read
router.post('/:id/read', NotificationController.markRead);

// POST /api/v1/notifications/read-all
router.post('/read-all', NotificationController.markAllRead);

module.exports = router;
