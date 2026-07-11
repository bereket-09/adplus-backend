/**
 * store.js — Atomic primitives used by the decision engine.
 *
 * Backed by Redis when available (authoritative, shared across processes) and by
 * an in-process implementation otherwise. The in-process path is safe only for a
 * single Node process because Node's event loop serialises synchronous critical
 * sections — it is a DEV convenience, not a production substitute for Redis.
 *
 * All monetary counters are integers (ETB cents) so reservations can never drift
 * a campaign below zero.
 */

const redis = require('./redis');

// ---------------------------------------------------------------------------
// Lua scripts (Redis path) — each runs atomically on the server.
// ---------------------------------------------------------------------------

// Conditionally decrement a counter, seeding it from `seed` if it doesn't exist.
// KEYS[1]=counter  ARGV[1]=amount  ARGV[2]=seed(optional, -1 = "must already exist")
// Returns: new value on success, -1 if counter missing & no seed, -2 if insufficient.
const RESERVE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  if ARGV[2] == '-1' then return -1 end
  redis.call('SET', KEYS[1], ARGV[2])
  cur = ARGV[2]
end
cur = tonumber(cur)
local amt = tonumber(ARGV[1])
if cur < amt then return -2 end
return redis.call('DECRBY', KEYS[1], amt)
`;

// Token-bucket acquire. KEYS[1]=bucket
// ARGV[1]=ratePerSec ARGV[2]=burst ARGV[3]=cost ARGV[4]=ttlSec
// Returns: {allowed(1/0), tokensLeft(millitokens), waitMs}
const TOKEN_BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = burst * 1000 end
if ts == nil then ts = now end
-- refill (millitokens)
local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(burst * 1000, tokens + (elapsed * rate))
  ts = now
end
local costm = cost * 1000
local allowed = 0
local waitMs = 0
if tokens >= costm then
  tokens = tokens - costm
  allowed = 1
else
  waitMs = math.ceil((costm - tokens) / rate)
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ts)
redis.call('EXPIRE', KEYS[1], ttl)
return {allowed, math.floor(tokens), waitMs}
`;

// ---------------------------------------------------------------------------
// In-memory fallback state
// ---------------------------------------------------------------------------
const mem = {
  kv: new Map(),        // key -> { value, expiry }
  sets: new Map(),      // key -> { set:Set, expiry }
  buckets: new Map(),   // key -> { tokens(milli), ts }
};

function memGetLive(map, key) {
  const it = map.get(key);
  if (!it) return null;
  if (it.expiry && Date.now() > it.expiry) { map.delete(key); return null; }
  return it;
}

const useRedis = () => redis.enabled;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * Atomically reserve `amount` from a counter, seeding from `seed` on first use.
   * @returns {Promise<{ok:boolean, reason?:string, remaining?:number}>}
   */
  async reserve(key, amount, seed = null) {
    if (amount <= 0) return { ok: true, remaining: seed ?? 0 };
    if (useRedis()) {
      const res = await redis.client.eval(RESERVE_LUA, 1, key, amount, seed == null ? '-1' : String(seed));
      if (res === -1) return { ok: false, reason: 'uninitialised' };
      if (res === -2) return { ok: false, reason: 'insufficient' };
      return { ok: true, remaining: Number(res) };
    }
    // in-memory
    let it = memGetLive(mem.kv, key);
    if (!it) {
      if (seed == null) return { ok: false, reason: 'uninitialised' };
      it = { value: Number(seed), expiry: 0 };
      mem.kv.set(key, it);
    }
    if (it.value < amount) return { ok: false, reason: 'insufficient' };
    it.value -= amount;
    return { ok: true, remaining: it.value };
  },

  /** Return `amount` to a counter (release a reservation). */
  async release(key, amount) {
    if (amount <= 0) return;
    if (useRedis()) { await redis.client.incrby(key, amount); return; }
    const it = memGetLive(mem.kv, key);
    if (it) it.value += amount; else mem.kv.set(key, { value: Number(amount), expiry: 0 });
  },

  /** Read a counter (null if unset). */
  async getCounter(key) {
    if (useRedis()) { const v = await redis.client.get(key); return v == null ? null : Number(v); }
    const it = memGetLive(mem.kv, key);
    return it ? it.value : null;
  },

  /** Set a counter to an exact value (used by resync). */
  async setCounter(key, value) {
    if (useRedis()) { await redis.client.set(key, Math.round(value)); return; }
    mem.kv.set(key, { value: Math.round(value), expiry: 0 });
  },

  /** INCR a counter and ensure a TTL — used for frequency windows. Returns new count. */
  async incrWithTtl(key, ttlSeconds) {
    if (useRedis()) {
      const v = await redis.client.incr(key);
      if (v === 1) await redis.client.expire(key, ttlSeconds);
      return v;
    }
    let it = memGetLive(mem.kv, key);
    if (!it) { it = { value: 0, expiry: Date.now() + ttlSeconds * 1000 }; mem.kv.set(key, it); }
    it.value += 1;
    return it.value;
  },

  async getInt(key) {
    if (useRedis()) { const v = await redis.client.get(key); return v == null ? 0 : Number(v); }
    const it = memGetLive(mem.kv, key);
    return it ? Number(it.value) : 0;
  },

  async setString(key, value, ttlSeconds) {
    if (useRedis()) {
      if (ttlSeconds) await redis.client.set(key, value, 'EX', ttlSeconds);
      else await redis.client.set(key, value);
      return;
    }
    mem.kv.set(key, { value, expiry: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
  },

  async getString(key) {
    if (useRedis()) return redis.client.get(key);
    const it = memGetLive(mem.kv, key);
    return it ? it.value : null;
  },

  // ---- Set operations (seen-set) ----
  async setAdd(key, member, ttlSeconds) {
    if (useRedis()) {
      await redis.client.sadd(key, member);
      if (ttlSeconds) await redis.client.expire(key, ttlSeconds);
      return;
    }
    let it = memGetLive(mem.sets, key);
    if (!it) { it = { set: new Set(), expiry: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 }; mem.sets.set(key, it); }
    it.set.add(member);
  },

  async setMembers(key) {
    if (useRedis()) return redis.client.smembers(key);
    const it = memGetLive(mem.sets, key);
    return it ? Array.from(it.set) : [];
  },

  async setCard(key) {
    if (useRedis()) return redis.client.scard(key);
    const it = memGetLive(mem.sets, key);
    return it ? it.set.size : 0;
  },

  /**
   * Token-bucket acquire.
   * @returns {Promise<{allowed:boolean, waitMs:number}>}
   */
  async acquireToken(key, ratePerSec, burst, cost = 1, ttlSeconds = 3600) {
    if (useRedis()) {
      const [allowed, , waitMs] = await redis.client.eval(
        TOKEN_BUCKET_LUA, 1, key, ratePerSec, burst, cost, ttlSeconds
      );
      return { allowed: allowed === 1, waitMs: Number(waitMs) };
    }
    // in-memory bucket
    const now = Date.now();
    let b = mem.buckets.get(key);
    if (!b) { b = { tokens: burst * 1000, ts: now }; mem.buckets.set(key, b); }
    const elapsed = now - b.ts;
    if (elapsed > 0) { b.tokens = Math.min(burst * 1000, b.tokens + elapsed * ratePerSec); b.ts = now; }
    const costm = cost * 1000;
    if (b.tokens >= costm) { b.tokens -= costm; return { allowed: true, waitMs: 0 }; }
    return { allowed: false, waitMs: Math.ceil((costm - b.tokens) / ratePerSec) };
  },
};
