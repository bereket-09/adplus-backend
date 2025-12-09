const Marketer = require('../models/marketer.model');
const WatchLink = require('../models/watchLink.model');
const Ad = require('../models/ad.model');
const Reward = require('../models/reward.model');
const MarketerTransaction = require('../models/marketerTransaction.model');
const logger = require('./logger'); // <-- add logger

exports.deductBudget = async (marketer_id, ad_id) => {
  logger.info(`RewardEngine.deductBudget - Starting deduction | marketer_id: ${marketer_id}, ad_id: ${ad_id}`);

  const marketer = await Marketer.findById(marketer_id);
  const ad = await Ad.findById(ad_id);
  if (!marketer) {
    logger.error(`RewardEngine.deductBudget - Marketer not found | marketer_id: ${marketer_id}`);
    throw { status: 404, message: 'marketer not found' };
  }
  if (!ad) {
    logger.error(`RewardEngine.deductBudget - Ad not found | ad_id: ${ad_id}`);
    throw { status: 404, message: 'ad not found' };
  }

  const cost = ad.cost_per_view || 1;
  const previous_budget = marketer.remaining_budget;
  marketer.remaining_budget -= cost;

  if (marketer.remaining_budget <= 0) {
    marketer.remaining_budget = 0;
    await Ad.updateMany({ marketer_id }, { status: 'paused' });
    logger.info(`RewardEngine.deductBudget - Marketer budget depleted, pausing ads | marketer_id: ${marketer_id}`);
  }

  await marketer.save();
  logger.info(`RewardEngine.deductBudget - Deducted ${cost} from marketer | previous_budget: ${previous_budget}, new_budget: ${marketer.remaining_budget}`);

  // Store in marketer transaction logs
  await MarketerTransaction.create({
    marketer_id: marketer._id,
    type: 'deduction',
    amount: cost,
    previous_budget,
    new_budget: marketer.remaining_budget,
    reason: 'Ad watched deduction',
    description: `Deducted ${cost} for ad ${ad._id}`
  });

  return marketer;
};

exports.grantReward = async (msisdn, token) => {
  logger.info(`RewardEngine.grantReward - Granting reward | msisdn: ${msisdn}, token: ${token}`);

  const watch = await WatchLink.findOne({ token });
  if (!watch) {
    logger.error(`RewardEngine.grantReward - Watch session not found | token: ${token}`);
    throw { status: 404, message: 'watch session not found for reward' };
  }

  const offerId = `OFFER-${Math.floor(Math.random() * 1000000)}`;

  const reward = await Reward.create({
    msisdn,
    token,
    ad_id: watch.ad_id,
    offer_id: offerId,
    status: 'granted'
  });

  logger.info(`RewardEngine.grantReward - Reward stored | MSISDN: ${msisdn}, token: ${token}, offerId: ${offerId}, reward_id: ${reward._id}`);

  return { granted: true, offer_id: offerId, reward_id: reward._id };
};
