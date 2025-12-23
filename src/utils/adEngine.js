// const Ad = require('../models/ad.model');

// exports.selectAd = async () => {
//   const now = new Date();
//   const ad = await Ad.findOne({
//     status: 'active',
//     remaining_budget: { $gt: 0 },
//     start_date: { $lte: now },
//     end_date: { $gte: now }
//   }).sort({ created_at: 1 });
//   return ad;
// };

const Ad = require('../models/ad.model');

// In-memory store: { msisdn: [adId1, adId2, ...] }
const userAdMemory = {};

exports.selectAd = async (msisdn) => {
  const now = new Date();

  // Fetch all active ads
  const activeAds = await Ad.find({
    status: 'active',
    remaining_budget: { $gt: 0 },
    start_date: { $lte: now },
    end_date: { $gte: now },
  }).sort({ created_at: 1 });

  if (!activeAds.length) return null;

  // Initialize memory for the user
  if (!userAdMemory[msisdn] || userAdMemory[msisdn].length === 0) {
    // Shuffle ads
    const shuffledAds = activeAds.map(ad => ad._id.toString()).sort(() => Math.random() - 0.5);
    userAdMemory[msisdn] = shuffledAds;
  }

  // Pop the next ad from memory
  const nextAdId = userAdMemory[msisdn].shift();
  const nextAd = activeAds.find(ad => ad._id.toString() === nextAdId);

  return nextAd;
};
