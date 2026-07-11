/**
 * ensure-indexes.js — Build/sync all Mongo indexes safely, off-peak.
 *
 * Run this manually (NOT during the morning burst) after deploying index changes,
 * because production boots with autoIndex:false:
 *
 *   NODE_ENV=production node scripts/ensure-indexes.js
 *
 * It first de-duplicates rewards by `token` (older data may contain duplicates
 * from the pre-fix double-complete race) so the new unique index can build, then
 * syncs indexes for every model.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/video_ads';

const models = {
  Ad: require('../src/models/ad.model'),
  WatchLink: require('../src/models/watchLink.model'),
  Marketer: require('../src/models/marketer.model'),
  Reward: require('../src/models/reward.model'),
  MarketerTransaction: require('../src/models/marketerTransaction.model'),
  AuditLog: require('../src/models/audit.model'),
  FraudDetection: require('../src/models/fraudDetection.model'),
  Blacklist: require('../src/models/blacklist.model'),
  BillingModel: require('../src/models/billingModel.model'),
  SystemConfig: require('../src/models/systemConfig.model'),
  User: require('../src/models/user.model'),
};

async function dedupeRewardTokens() {
  const Reward = models.Reward;
  const dupes = await Reward.aggregate([
    { $group: { _id: '$token', ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  let removed = 0;
  for (const d of dupes) {
    // keep the first, drop the rest
    const drop = d.ids.slice(1);
    const res = await Reward.deleteMany({ _id: { $in: drop } });
    removed += res.deletedCount || 0;
  }
  if (removed) logger.info(`ensure-indexes - removed ${removed} duplicate reward(s) before unique index`);
}

async function main() {
  mongoose.set('strictQuery', false);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  logger.info('ensure-indexes - connected');

  await dedupeRewardTokens();

  for (const [name, model] of Object.entries(models)) {
    try {
      await model.syncIndexes();
      logger.info(`ensure-indexes - ${name}: indexes synced`);
    } catch (e) {
      logger.error(`ensure-indexes - ${name}: ${e.message}`);
    }
  }

  await mongoose.disconnect();
  logger.info('ensure-indexes - done');
  process.exit(0);
}

main().catch((e) => { logger.error(`ensure-indexes - fatal: ${e.message}`); process.exit(1); });
