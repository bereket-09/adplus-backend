const express = require('express');
const router = express.Router();
const ScheduleController = require('../../controllers/schedule.controller');

// verifyToken is applied globally in v1/index.js before these are mounted, so
// req.user is populated on every handler here. The POST additionally enforces
// ownership: it only updates the ad when { _id, marketer_id: req.user.id }
// matches, so a marketer can never edit another marketer's schedule.

// GET /api/v1/schedule/:adId
router.get('/:adId', ScheduleController.getSchedule);

// POST /api/v1/schedule/:adId  { start_date, end_date }
router.post('/:adId', ScheduleController.updateSchedule);

module.exports = router;
