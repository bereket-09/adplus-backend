require('dotenv').config();
const app = require('./src/app');
const mongoose = require('mongoose');
const logger = require('./src/utils/logger');
const redis = require('./src/lib/redis');
const decisionWorker = require('./src/workers/decisionWorker');
const reservationSweeper = require('./src/workers/reservationSweeper');
const fraudAnalyzer = require('./src/workers/fraudAnalyzer');
const WatchLink = require('./src/models/watchLink.model');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/video_ads';
// Set WORKERS_ENABLED=false on API-only nodes so a separate worker fleet drains
// the queue. Default: this process both serves and works (fine for small setups).
const WORKERS_ENABLED = String(process.env.WORKERS_ENABLED || 'true').toLowerCase() !== 'false';

mongoose.set('strictQuery', false);

/**
 * Remove the legacy TTL index on `expires_at` (expireAfterSeconds:0). It would
 * delete watch links at the 3h watch expiry, destroying reserved-budget records
 * before the sweeper can release them. The new TTL lives on `purge_at` (7d).
 */
async function migrateWatchLinkIndexes() {
  try {
    const indexes = await WatchLink.collection.indexes();
    const legacy = indexes.find((i) => i.name === 'expires_at_1' && i.expireAfterSeconds === 0);
    if (legacy) {
      await WatchLink.collection.dropIndex('expires_at_1');
      logger.info('startup - dropped legacy expires_at TTL index');
    }
  } catch (e) {
    logger.warn(`startup - watchlink index migration skipped: ${e.message}`);
  }
  // Only auto-sync indexes outside production. In production, index builds (esp.
  // on the large watchlinks/auditlogs collections and the rewards unique index)
  // must be run off-peak via `node scripts/ensure-indexes.js`, never on a deploy
  // during the morning burst.
  if (process.env.NODE_ENV !== 'production') {
    try { await WatchLink.syncIndexes(); } catch (e) { logger.warn(`startup - syncIndexes: ${e.message}`); }
  }
}

async function start() {
  // Redis first — the decision engine's correctness depends on it in production.
  redis.init();
  if (!redis.isConfigured()) {
    logger.warn('startup - REDIS_URL not set; using in-memory fallback (single-process DEV only, NOT safe when scaled)');
  }

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 20,          // plenty for 2 vCPU; bigger pools just queue on CPU
    minPoolSize: 5,
    maxIdleTimeMS: 60000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    retryWrites: true,
    w: 'majority',
    autoIndex: process.env.NODE_ENV !== 'production', // build indexes off-peak in prod
  });
  logger.info('startup - MongoDB connected');

  await migrateWatchLinkIndexes();

  app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));

  if (WORKERS_ENABLED) {
    await decisionWorker.start();
    reservationSweeper.start();
    fraudAnalyzer.start();
  } else {
    logger.info('startup - WORKERS_ENABLED=false, this node serves API only');
  }
}

start().catch((err) => {
  logger.error(`startup - fatal: ${err.message}`);
  process.exit(1);
});
