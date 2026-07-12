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

  const url = cfg.redis.url;
  // Upstash (and any managed Redis) requires TLS. Enable it for rediss:// URLs,
  // for *.upstash.io hosts (even if given as redis://), or via REDIS_TLS=true.
  const needsTls =
    /^rediss:\/\//i.test(url) ||
    /upstash\.io/i.test(url) ||
    String(process.env.REDIS_TLS || '').toLowerCase() === 'true';

  const commonOpts = {
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };
  if (needsTls) commonOpts.tls = { rejectUnauthorized: true };

  // Namespaced client for all general keys (counters, sets, buckets).
  client = new Redis(url, { keyPrefix: cfg.redis.keyPrefix, maxRetriesPerRequest: 3, ...commonOpts });

  // Raw client WITHOUT keyPrefix, used only for stream commands. ioredis applies
  // keyPrefix inconsistently across XADD/XREADGROUP vs XGROUP (whose key position
  // it can't infer), which corrupts consumer-group routing. It also runs the
  // BLOCKING XREADGROUP, so maxRetriesPerRequest MUST be null (ioredis requirement
  // for blocking commands — otherwise blocking reads error under latency/Upstash).
  rawClient = new Redis(url, { maxRetriesPerRequest: null, ...commonOpts });

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
