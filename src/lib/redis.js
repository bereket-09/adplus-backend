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
let rawClient = null;
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

  const baseOpts = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };

  // Namespaced client for all general keys (counters, sets, buckets).
  client = new Redis(cfg.redis.url, { keyPrefix: cfg.redis.keyPrefix, ...baseOpts });

  // Raw client WITHOUT keyPrefix, used only for stream commands. ioredis applies
  // keyPrefix inconsistently across XADD/XREADGROUP vs XGROUP (whose key position
  // it can't infer), which corrupts consumer-group routing. Using a prefix-free
  // connection with fully-qualified stream keys avoids that entirely.
  rawClient = new Redis(cfg.redis.url, baseOpts);

  client.on('ready', () => { enabled = true; logger.info('redis: connected'); });
  client.on('error', (err) => { logger.error(`redis: ${err.message}`); });
  client.on('end', () => { enabled = false; logger.warn('redis: connection closed'); });
  rawClient.on('error', (err) => { logger.error(`redis(raw): ${err.message}`); });

  return client;
}

module.exports = {
  init,
  get client() { return client; },
  get rawClient() { return rawClient; },
  get enabled() { return enabled && !!client; },
  isConfigured() { return !!cfg.redis.url; },
};
