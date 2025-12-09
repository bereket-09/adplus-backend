const Ad = require('../models/ad.model');

exports.selectAd = async () => {
  const now = new Date();
  const ad = await Ad.findOne({
    status: 'active',
    remaining_budget: { $gt: 0 },
    start_date: { $lte: now },
    end_date: { $gte: now }
  }).sort({ created_at: 1 });
  return ad;
};
