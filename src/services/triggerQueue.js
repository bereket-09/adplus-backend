/**
 * triggerQueue.js — Buffer between OCS ingestion and the paced decision workers.
 *
 * This queue is what absorbs the morning stampede: OCS triggers land here
 * instantly (cheap XADD), and workers drain them at the rate pacing + budget
 * allow. Excess beyond what the window can serve is trimmed (MAXLEN) — those
 * triggers would go stale anyway.
 *
 * Driver:
 *   - redis  : Redis Streams + consumer group (load-balances across processes)
 *   - memory : in-process array (single-process dev only)
 * 'auto' picks redis when REDIS_URL is set.
 */

const redis = require('../lib/redis');
const cfg = require('../config/engine');
const logger = require('../utils/logger');

// Fully-qualified stream key. We use raw client.call() for all stream commands
// so ioredis's keyPrefix is bypassed uniformly — mixing prefixed high-level calls
// (xadd/xreadgroup) with XGROUP, whose key position ioredis can't reliably infer,
// otherwise creates the group on the wrong key and yields NOGROUP errors.
const STREAM = (cfg.redis.keyPrefix || '') + 'triggers';
const GROUP = cfg.queue.group;

function driver() {
  if (cfg.queue.driver === 'redis') return 'redis';
  if (cfg.queue.driver === 'memory') return 'memory';
  return redis.enabled ? 'redis' : 'memory';
}

// ---- in-memory fallback ----
const memQ = [];
let memRunning = false;

async function enqueue(candidate) {
  const payload = JSON.stringify(candidate);
  if (driver() === 'redis') {
    await redis.rawClient.call('XADD', STREAM, 'MAXLEN', '~', String(cfg.queue.maxLen), '*', 'p', payload);
  } else {
    if (memQ.length < cfg.queue.maxLen) memQ.push(candidate);
  }
}

async function enqueueBatch(candidates) {
  for (const c of candidates) await enqueue(c);
  return candidates.length;
}

async function ensureGroup() {
  try {
    await redis.rawClient.call('XGROUP', 'CREATE', STREAM, GROUP, '$', 'MKSTREAM');
  } catch (e) {
    if (!String(e.message).includes('BUSYGROUP')) throw e;
  }
}

/**
 * Start draining. `handler(candidate)` is awaited per item. `pace()` is an async
 * gate the worker awaits before pulling the next item, so the global SMS-gateway
 * rate limit governs throughput.
 */
async function startConsumers(handler, pace) {
  const d = driver();
  logger.info(`triggerQueue: driver='${d}', workers=${cfg.queue.workerConcurrency}`);

  if (d === 'redis') {
    await ensureGroup();
    for (let i = 0; i < cfg.queue.workerConcurrency; i++) {
      runRedisConsumer(`w-${process.pid}-${i}`, handler, pace);
    }
  } else {
    if (memRunning) return;
    memRunning = true;
    for (let i = 0; i < cfg.queue.workerConcurrency; i++) {
      runMemoryConsumer(handler, pace);
    }
  }
}

async function runRedisConsumer(name, handler, pace) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await redis.rawClient.call(
        'XREADGROUP', 'GROUP', GROUP, name, 'COUNT', String(cfg.queue.batchSize),
        'BLOCK', '5000', 'STREAMS', STREAM, '>'
      );
      if (!res) continue;
      const [, entries] = res[0];
      for (const [id, fields] of entries) {
        try {
          await pace();
          const idx = fields.indexOf('p');
          const candidate = JSON.parse(fields[idx + 1]);
          await handler(candidate);
        } catch (err) {
          logger.error(`triggerQueue.consumer - ${err.message}`);
        } finally {
          redis.rawClient.call('XACK', STREAM, GROUP, id).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(`triggerQueue.redisConsumer - ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function runMemoryConsumer(handler, pace) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = memQ.shift();
    if (!candidate) { await new Promise((r) => setTimeout(r, 100)); continue; }
    try {
      await pace();
      await handler(candidate);
    } catch (err) {
      logger.error(`triggerQueue.memoryConsumer - ${err.message}`);
    }
  }
}

async function depth() {
  if (driver() === 'redis') {
    try { return await redis.rawClient.call('XLEN', STREAM); } catch { return -1; }
  }
  return memQ.length;
}

module.exports = { enqueue, enqueueBatch, startConsumers, depth, driver };
