const Blacklist = require('../models/blacklist.model');
const cache = require('./internalCache');
const logger = require('./logger');

const CACHE_KEY = 'blacklist:active';
const CACHE_TTL = 30_000; // 30 seconds

/**
 * Load active blacklist entries into cache
 */
async function loadBlacklist() {
    const cached = cache.get(CACHE_KEY);
    if (cached) return cached;

    const entries = await Blacklist.find({
        is_active: true,
        $or: [
            { expires_at: null },
            { expires_at: { $gt: new Date() } }
        ]
    }).lean();

    const indexed = {
        msisdn: new Set(),
        ip: new Set(),
        device: new Set(),
        user_agent: new Set(),
        // severity map: value -> severity
        severityMap: {}
    };

    for (const entry of entries) {
        indexed[entry.type]?.add(entry.value);
        indexed.severityMap[`${entry.type}:${entry.value}`] = entry.severity;
    }

    cache.set(CACHE_KEY, indexed, CACHE_TTL);
    return indexed;
}

/**
 * Check if an MSISDN is blacklisted
 */
async function isMsisdnBlacklisted(msisdn) {
    const bl = await loadBlacklist();
    return bl.msisdn.has(msisdn);
}

/**
 * Check if an IP is blacklisted
 */
async function isIpBlacklisted(ip) {
    const bl = await loadBlacklist();
    return bl.ip.has(ip);
}

/**
 * Full check: returns { blocked, reasons[] }
 */
async function checkAll({ msisdn, ip, userAgent }) {
    const bl = await loadBlacklist();
    const reasons = [];

    if (msisdn && bl.msisdn.has(msisdn)) {
        reasons.push({ type: 'msisdn', value: msisdn, severity: bl.severityMap[`msisdn:${msisdn}`] || 'block' });
    }
    if (ip && bl.ip.has(ip)) {
        reasons.push({ type: 'ip', value: ip, severity: bl.severityMap[`ip:${ip}`] || 'block' });
    }
    if (userAgent && bl.user_agent.has(userAgent)) {
        reasons.push({ type: 'user_agent', value: userAgent, severity: bl.severityMap[`user_agent:${userAgent}`] || 'warn' });
    }

    const blocked = reasons.some(r => r.severity === 'block' || r.severity === 'permanent');

    if (blocked) {
        // Increment hit counts in background (non-blocking)
        for (const reason of reasons) {
            Blacklist.updateOne(
                { type: reason.type, value: reason.value },
                { $inc: { hit_count: 1 }, $set: { last_hit_at: new Date() } }
            ).catch(err => logger.error(`Blacklist hit update error: ${err.message}`));
        }
    }

    return { blocked, reasons };
}

/**
 * Invalidate cache (call after add/remove/update)
 */
function invalidateCache() {
    cache.del(CACHE_KEY);
}

module.exports = { isMsisdnBlacklisted, isIpBlacklisted, checkAll, invalidateCache, loadBlacklist };
