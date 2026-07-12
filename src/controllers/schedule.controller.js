/**
 * schedule.controller.js — Read + update a campaign's run window.
 *
 * GET  returns { start_date, end_date, active } from the Ad. "active" is derived
 *      from now being inside the window AND the ad's status being 'active'.
 * POST updates the dates, but only after verifying the authenticated marketer
 *      (req.user.id) owns the ad — a marketer must never edit another's schedule.
 */

const mongoose = require('mongoose');
const Ad = require('../models/ad.model');
const logger = require('../utils/logger');

// Is `ad` live right now: status active and now within [start,end] (open-ended
// bounds count as satisfied).
function isActive(ad) {
  if (ad.status !== 'active') return false;
  const now = Date.now();
  if (ad.start_date && new Date(ad.start_date).getTime() > now) return false;
  if (ad.end_date && new Date(ad.end_date).getTime() < now) return false;
  return true;
}

/**
 * GET /schedule/:adId => { start_date, end_date, active }
 */
exports.getSchedule = async (req, res, next) => {
  try {
    const { adId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(adId)) {
      return res.status(400).json({ status: false, error: 'Invalid ad id' });
    }

    const ad = await Ad.findById(adId)
      .select('start_date end_date status marketer_id')
      .lean();
    if (!ad) return res.status(404).json({ status: false, error: 'Campaign not found' });

    res.json({
      status: true,
      ad_id: adId,
      start_date: ad.start_date || null,
      end_date: ad.end_date || null,
      active: isActive(ad),
    });
  } catch (err) {
    logger.error(`ScheduleController.getSchedule - Error: ${err.message}`);
    next(err);
  }
};

/**
 * POST /schedule/:adId  body: { start_date, end_date }
 * Ownership-checked update of the run window.
 */
exports.updateSchedule = async (req, res, next) => {
  try {
    const { adId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(adId)) {
      return res.status(400).json({ status: false, error: 'Invalid ad id' });
    }
    const marketerId = req.user && req.user.id;
    if (!marketerId) {
      return res.status(401).json({ status: false, error: 'Unauthorized' });
    }

    const { start_date, end_date } = req.body || {};

    // Parse + validate any provided dates before writing.
    const update = {};
    if (start_date !== undefined) {
      if (start_date === null || start_date === '') {
        update.start_date = null;
      } else {
        const sd = new Date(start_date);
        if (isNaN(sd.getTime())) return res.status(400).json({ status: false, error: 'Invalid start_date' });
        update.start_date = sd;
      }
    }
    if (end_date !== undefined) {
      if (end_date === null || end_date === '') {
        update.end_date = null;
      } else {
        const ed = new Date(end_date);
        if (isNaN(ed.getTime())) return res.status(400).json({ status: false, error: 'Invalid end_date' });
        update.end_date = ed;
      }
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ status: false, error: 'Provide start_date and/or end_date' });
    }
    if (update.start_date && update.end_date && update.end_date < update.start_date) {
      return res.status(400).json({ status: false, error: 'end_date must be after start_date' });
    }

    // Ownership: only touch the ad if it belongs to this marketer. A single
    // conditional update — no read-then-write race, and a non-owner gets 404.
    const ad = await Ad.findOneAndUpdate(
      { _id: adId, marketer_id: marketerId },
      { $set: update },
      { new: true, projection: 'start_date end_date status marketer_id' }
    ).lean();

    if (!ad) {
      // Distinguish "not yours" from "doesn't exist" without leaking existence.
      const exists = await Ad.exists({ _id: adId });
      if (exists) return res.status(403).json({ status: false, error: 'Not authorized for this campaign' });
      return res.status(404).json({ status: false, error: 'Campaign not found' });
    }

    logger.info(`ScheduleController.updateSchedule - marketer ${marketerId} updated ad ${adId} schedule`);
    res.json({
      status: true,
      ad_id: adId,
      start_date: ad.start_date || null,
      end_date: ad.end_date || null,
      active: isActive(ad),
    });
  } catch (err) {
    logger.error(`ScheduleController.updateSchedule - Error: ${err.message}`);
    next(err);
  }
};
