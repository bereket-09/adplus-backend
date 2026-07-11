/**
 * redis.js — Lazily-connected ioredis client.
 *
 * If REDIS_URL is not configured the module reports `enabled === false` and the
 * store layer transparently falls back to an in-process implementation. That
 * fallback is correct ONLY for a single process (dev). Production MUST set
 * REDIS_URL so budget counters, pacing, and frequency state are shared across
 * every API/worker process.
 */

const cfg = require('../config/engine');
const logger = require('../utils/logger');

let client = null;
let enabled = false;

function init() {
  if (client || !cfg.redis.url) return client;
  // Require lazily so the dependency is optional in dev environments.
  let Redis;
  try {
    Redis = require('ioredis');
  } catch (e) {
    logger.warn('redis: ioredis not installed; using in-memory fallback (dev only)');
    return null;
  }

  client = new Redis(cfg.redis.url, {
    keyPrefix: cfg.redis.keyPrefix,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  client.on('ready', () => { enabled = true; logger.info('redis: connected'); });
  client.on('error', (err) => { logger.error(`redis: ${err.message}`); });
  client.on('end', () => { enabled = false; logger.warn('redis: connection closed'); });

  return client;
}

module.exports = {
  init,
  get client() { return client; },
  get enabled() { return enabled && !!client; },
  isConfigured() { return !!cfg.redis.url; },
};
