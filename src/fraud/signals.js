/**
 * signals.js — One detector per fraud signal. Each returns
 *   { id, hit:boolean, weight:number, value, hard?:boolean }
 * and reads/writes only Redis (via store.js). No Mongo on the hot path.
 *
 * The engine selects a stage-appropriate subset and runs them concurrently.
 */
const store = require('../lib/store');
const cfg = require('../config/engine');
const k = require('./keys');
const fp = require('./fingerprint');
const frequency = require('../services/frequency');
const blacklistCheck = require('../utils/blacklistCheck');

const W = {
  vel_msisdn: 25, vel_ip: 20, vel_device: 20,
  simfarm_ip: 40, simfarm_device: 45, msisdn_per_ip_burst: 30,
  reward_farming: 30, reward_velocity_ip: 25,
  fast_complete: 45, no_progress: 20,
  replay_key: 35, replay_tuple: 30, meta_tamper: 30,
  ip_rotation: 25, ua_rotation: 15, bot_fingerprint: 35,
  geo_anomaly: 25, new_subscriber: 12, reputation: 20,
};

const miss = (id) => ({ id, hit: false, weight: 0, value: 0 });

// ---- velocity (token buckets) ----
async function vel_msisdn(s) {
  if (!s.msisdn) return miss('vel_msisdn');
  const { allowed } = await store.acquireToken(k.velMsisdn(s.msisdn), cfg.fraud.velocity.msisdnRps, cfg.fraud.velocity.msisdnBurst, 1, 3600);
  return { id: 'vel_msisdn', hit: !allowed, weight: allowed ? 0 : W.vel_msisdn, value: allowed ? 0 : 1 };
}
async function vel_ip(s) {
  if (!s.ip) return miss('vel_ip');
  const { allowed } = await store.acquireToken(k.velIp(s.ip), cfg.fraud.velocity.ipRps, cfg.fraud.velocity.ipBurst, 1, 3600);
  return { id: 'vel_ip', hit: !allowed, weight: allowed ? 0 : W.vel_ip, value: allowed ? 0 : 1 };
}
async function vel_device(s) {
  if (!s.deviceFp) return miss('vel_device');
  const { allowed } = await store.acquireToken(k.velDev(s.deviceFp), cfg.fraud.velocity.devRps, cfg.fraud.velocity.devBurst, 1, 3600);
  return { id: 'vel_device', hit: !allowed, weight: allowed ? 0 : W.vel_device, value: allowed ? 0 : 1 };
}

// ---- SIM-farm fan-out ----
async function simfarm_ip(s) {
  if (!s.ip || !s.msisdn) return miss('simfarm_ip');
  await store.setAdd(k.fanIp(s.ip), s.msisdn, cfg.fraud.simfarm.fanoutTtlSec);
  await store.setAdd(k.fanIpIndex, s.ip, cfg.fraud.simfarm.fanoutTtlSec);
  const card = await store.setCard(k.fanIp(s.ip));
  if (card >= cfg.fraud.simfarm.ipHardMax) return { id: 'simfarm_ip', hit: true, hard: true, weight: W.simfarm_ip, value: card };
  if (card >= cfg.fraud.simfarm.ipMax) return { id: 'simfarm_ip', hit: true, weight: W.simfarm_ip, value: card };
  return { id: 'simfarm_ip', hit: false, weight: 0, value: card };
}
async function simfarm_device(s) {
  if (!s.deviceFp || !s.msisdn) return miss('simfarm_device');
  await store.setAdd(k.fanDev(s.deviceFp), s.msisdn, cfg.fraud.simfarm.fanoutTtlSec);
  await store.setAdd(k.fanDevIndex, s.deviceFp, cfg.fraud.simfarm.fanoutTtlSec);
  const card = await store.setCard(k.fanDev(s.deviceFp));
  if (card >= cfg.fraud.simfarm.devHardMax) return { id: 'simfarm_device', hit: true, hard: true, weight: W.simfarm_device, value: card };
  if (card >= cfg.fraud.simfarm.devMax) return { id: 'simfarm_device', hit: true, weight: W.simfarm_device, value: card };
  return { id: 'simfarm_device', hit: false, weight: 0, value: card };
}
async function msisdn_per_ip_burst(s) {
  if (!s.ip || !s.msisdn) return miss('msisdn_per_ip_burst');
  await store.setAdd(k.fanIpShort(s.ip), s.msisdn, 600);
  const card = await store.setCard(k.fanIpShort(s.ip));
  const hit = card >= cfg.fraud.simfarm.ipBurstMax;
  return { id: 'msisdn_per_ip_burst', hit, weight: hit ? W.msisdn_per_ip_burst : 0, value: card };
}

// ---- reward farming (complete stage) ----
async function reward_farming(s) {
  if (!s.deviceFp) return miss('reward_farming');
  const count = await store.getInt(k.rewardDev(s.deviceFp));
  const cap = cfg.frequency.maxViewsPerDay * cfg.fraud.rewardFarm.factor;
  const hit = count > cap;
  return { id: 'reward_farming', hit, weight: hit ? W.reward_farming : 0, value: count };
}
async function reward_velocity_ip(s) {
  if (!s.ip) return miss('reward_velocity_ip');
  const count = await store.getInt(k.rewardIpHour(s.ip));
  const hit = count > cfg.fraud.rewardFarm.ipHourMax;
  return { id: 'reward_velocity_ip', hit, weight: hit ? W.reward_velocity_ip : 0, value: count };
}

// ---- watch timing (complete stage) ----
function fast_complete(s, ctx) {
  const w = s.watch;
  if (!w || !w.started_at) return { id: 'fast_complete', hit: true, weight: W.fast_complete, value: 0 }; // completed without a start
  const elapsed = (Date.now() - new Date(w.started_at).getTime()) / 1000;
  const dur = ctx.durationSeconds || 0;
  const floor = dur > 0 ? dur * cfg.fraud.timing.minWatchRatio : 3; // <3s is implausible for any ad
  const hit = elapsed < floor;
  return { id: 'fast_complete', hit, weight: hit ? W.fast_complete : 0, value: Math.round(elapsed) };
}
function no_progress(s, ctx) {
  const w = s.watch;
  const dur = ctx.durationSeconds || 0;
  if (!w || !dur) return miss('no_progress');
  const hit = (w.max_position_reached || 0) < dur * cfg.fraud.timing.minProgressRatio;
  return { id: 'no_progress', hit, weight: hit ? W.no_progress : 0, value: w.max_position_reached || 0 };
}

// ---- replay ----
async function replay_key(s, ctx) {
  if (!s.token) return miss('replay_key');
  const stamp = `${s.ip || ''}|${s.deviceFp || ''}`;
  const key = k.replayKey(s.token, ctx.stage);
  const prior = await store.getString(key);
  await store.setString(key, stamp, 3 * 3600);
  const hit = !!prior && prior !== stamp;
  return { id: 'replay_key', hit, weight: hit ? W.replay_key : 0, value: hit ? 1 : 0, hard: hit };
}
async function replay_tuple(s) {
  if (!s.token) return miss('replay_tuple');
  await store.setAdd(k.replayTuple(s.token), `${s.ip || ''}|${s.deviceFp || ''}`, 3 * 3600);
  const card = await store.setCard(k.replayTuple(s.token));
  const hit = card >= 2;
  return { id: 'replay_tuple', hit, weight: hit ? W.replay_tuple : 0, value: card };
}

// ---- meta tamper ----
function meta_tamper(s) {
  const flags = s.metaFlags || [];
  const mismatch = s.watch && s.msisdn && s.watch.msisdn && s.watch.msisdn !== s.msisdn;
  const badGeo = fp.outsideBbox(s.location);
  const hit = flags.length > 0 || mismatch || badGeo;
  return { id: 'meta_tamper', hit, weight: hit ? W.meta_tamper : 0, value: mismatch ? 'msisdn_mismatch' : (badGeo ? 'geo_oob' : flags.join(',')) };
}

// ---- rotation ----
async function ip_rotation(s) {
  if (!s.msisdn || !s.ip) return miss('ip_rotation');
  await store.setAdd(k.rotIp(s.msisdn), s.ip, cfg.fraud.rotation.windowSec);
  const card = await store.setCard(k.rotIp(s.msisdn));
  const hit = card >= cfg.fraud.rotation.ipMax;
  return { id: 'ip_rotation', hit, weight: hit ? W.ip_rotation : 0, value: card };
}
async function ua_rotation(s) {
  if (!s.msisdn || !s.ua) return miss('ua_rotation');
  await store.setAdd(k.rotUa(s.msisdn), fp.classifyUa(s.ua) + ':' + s.ua.slice(0, 40), cfg.fraud.rotation.windowSec);
  const card = await store.setCard(k.rotUa(s.msisdn));
  const hit = card >= cfg.fraud.rotation.uaMax;
  return { id: 'ua_rotation', hit, weight: hit ? W.ua_rotation : 0, value: card };
}

// ---- bot fingerprint ----
function bot_fingerprint(s) {
  const hit = s.uaClass && s.uaClass !== 'normal';
  return { id: 'bot_fingerprint', hit, weight: hit ? W.bot_fingerprint : 0, value: s.uaClass };
}

// ---- geo impossible-travel ----
async function geo_anomaly(s) {
  if (!s.msisdn || !s.geoBucket) return miss('geo_anomaly');
  const raw = await store.getString(k.geoLast(s.msisdn));
  await store.setString(k.geoLast(s.msisdn), JSON.stringify({ b: s.geoBucket, ts: Date.now() }), cfg.fraud.geo.jumpWindowSec);
  if (!raw) return miss('geo_anomaly');
  let prev; try { prev = JSON.parse(raw); } catch { return miss('geo_anomaly'); }
  const within = Date.now() - (prev.ts || 0) < cfg.fraud.geo.jumpWindowSec * 1000;
  const dist = fp.bucketDistanceKm(prev.b, s.geoBucket);
  const hit = within && dist > cfg.fraud.geo.jumpKm;
  return { id: 'geo_anomaly', hit, weight: hit ? W.geo_anomaly : 0, value: Math.round(dist) };
}

// ---- new subscriber (mild multiplier trigger) ----
async function new_subscriber(s) {
  if (!s.msisdn) return miss('new_subscriber');
  const first = await store.getString(k.firstSeen(s.msisdn));
  if (!first) { await store.setString(k.firstSeen(s.msisdn), String(Date.now()), 90 * 86400); }
  const ageSec = first ? (Date.now() - Number(first)) / 1000 : 0;
  const done = await store.getInt(frequency.keys.engDone(s.msisdn));
  const hit = ageSec < cfg.fraud.newSub.ageSec && done === 0;
  return { id: 'new_subscriber', hit, weight: 0, value: Math.round(ageSec) }; // weight 0: acts as multiplier in engine
}

// ---- reputation (score preloaded by engine) ----
function reputation(s, ctx) {
  const rep = Math.max(ctx.repScores.msisdn || 0, ctx.repScores.ip || 0, ctx.repScores.device || 0);
  const hit = rep >= cfg.fraud.reputation.flagThreshold;
  return { id: 'reputation', hit, weight: hit ? W.reputation : 0, value: Math.round(rep) };
}

// ---- blacklist recheck (Mongo, 30s cached) ----
async function blacklist_recheck(s) {
  const res = await blacklistCheck.checkAll({ msisdn: s.msisdn, ip: s.ip, userAgent: s.ua, device: s.deviceFp });
  const hit = !!(res && res.blocked);
  return { id: 'blacklist_recheck', hit, hard: hit, weight: hit ? 100 : 0, value: hit ? (res.reasons || []).join(',') : '' };
}

const ALL = {
  vel_msisdn, vel_ip, vel_device, simfarm_ip, simfarm_device, msisdn_per_ip_burst,
  reward_farming, reward_velocity_ip, fast_complete, no_progress, replay_key, replay_tuple,
  meta_tamper, ip_rotation, ua_rotation, bot_fingerprint, geo_anomaly, new_subscriber,
  reputation, blacklist_recheck,
};

// Which signals run at each stage (from the spec's wiring table).
const STAGE_SIGNALS = {
  trigger: ['vel_msisdn', 'vel_ip', 'simfarm_ip', 'msisdn_per_ip_burst', 'ip_rotation', 'reputation'],
  decide: ['vel_msisdn', 'vel_ip', 'simfarm_ip', 'msisdn_per_ip_burst', 'ip_rotation', 'reputation'],
  open: ['vel_msisdn', 'vel_ip', 'vel_device', 'simfarm_device', 'msisdn_per_ip_burst', 'replay_key', 'replay_tuple', 'meta_tamper', 'ip_rotation', 'ua_rotation', 'bot_fingerprint', 'geo_anomaly', 'new_subscriber', 'blacklist_recheck'],
  start: ['vel_msisdn', 'vel_device', 'replay_key', 'replay_tuple', 'bot_fingerprint', 'blacklist_recheck'],
  complete: ['simfarm_device', 'reward_farming', 'reward_velocity_ip', 'fast_complete', 'no_progress', 'replay_key', 'replay_tuple', 'bot_fingerprint', 'geo_anomaly', 'blacklist_recheck'],
  click: ['vel_msisdn', 'vel_ip', 'vel_device', 'replay_tuple', 'bot_fingerprint', 'blacklist_recheck'],
};

module.exports = { ALL, STAGE_SIGNALS, WEIGHTS: W };
