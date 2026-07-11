/**
 * fraudAnalyzer.js — Async, off-hot-path pattern miner. Every interval it looks
 * for emergent SIM-farm fan-out (a device/IP suddenly across many MSISDNs) and
 * auto-escalates to the blacklist. Single-owner across processes via a Redis lock.
 */
const store = require('../lib/store');
const cfg = require('../config/engine');
const k = require('./../fraud/keys');
const autoBlacklist = require('../fraud/autoBlacklist');
const blacklistCheck = require('../utils/blacklistCheck');
const logger = require('../utils/logger');

let FraudDetection;
const detection = () => (FraudDetection || (FraudDetection = require('../models/fraudDetection.model')));

let timer = null;

async function acquireLock() {
  // Token bucket refilling ~1 per interval => exactly one process runs each tick,
  // and it self-heals (no stuck lock) because the token refills automatically.
  const { allowed } = await store.acquireToken(
    k.analyzerLock, 1 / cfg.fraud.analyzer.intervalSec, 1, 1, cfg.fraud.analyzer.intervalSec * 3
  );
  return allowed;
}

async function scanFanout(indexKey, fanKey, threshold, type) {
  let escalated = 0;
  const ids = await store.setMembers(indexKey);
  for (const id of ids.slice(0, 2000)) {
    const card = await store.setCard(fanKey(id));
    if (card >= threshold) {
      const bl = await blacklistCheck.checkAll(type === 'device' ? { device: id } : { ip: id });
      if (!bl.blocked) {
        await autoBlacklist.escalate(type, id, 'analyzer_fanout');
        detection().create({
          stage: 'analyzer', subject: type === 'device' ? { deviceFp: id } : { ip: id },
          score: 100, action: 'hard_block', reasons: ['analyzer_fanout'],
          signals: [{ id: 'fanout_' + type, value: card, weight: 100 }],
          source: 'analyzer', auto_action: 'blacklist:' + type, created_at: new Date(),
        }).catch(() => {});
        escalated++;
      }
    }
  }
  return escalated;
}

async function tick() {
  try {
    if (!(await acquireLock())) return; // another process owns this tick
    const dev = await scanFanout(k.fanDevIndex, k.fanDev, cfg.fraud.analyzer.deviceFanoutMax, 'device');
    const ip = await scanFanout(k.fanIpIndex, k.fanIp, cfg.fraud.analyzer.ipFanoutMax, 'ip');
    if (dev || ip) logger.info(`fraudAnalyzer - escalated device=${dev} ip=${ip}`);
  } catch (e) {
    logger.error(`fraudAnalyzer.tick - ${e.message}`);
  }
}

function start() {
  if (timer || !cfg.fraud.enabled || !cfg.fraud.analyzer.enabled) return;
  timer = setInterval(() => { tick(); }, cfg.fraud.analyzer.intervalSec * 1000);
  timer.unref?.();
  logger.info('fraudAnalyzer: started');
}

module.exports = { start, tick };
