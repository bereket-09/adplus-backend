/**
 * engine.js — Central, env-driven configuration for the ad-decision engine.
 *
 * Every knob that governs budget, pacing, frequency, and eligibility lives here
 * so it can be tuned per-deployment without touching logic. Values are read from
 * the environment with production-sane defaults.
 *
 * Currency note: all monetary values are ETB. Internally the budget ledger works
 * in integer CENTS (birr * 100) so Redis/Lua stays integer-atomic and float drift
 * can never oversell a campaign.
 */

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');

module.exports = {
  // ---- Redis / store ----------------------------------------------------
  redis: {
    url: process.env.REDIS_URL || '',            // empty => in-memory fallback (dev only)
    keyPrefix: process.env.REDIS_PREFIX || 'adplus:',
  },

  // ---- Budget ledger ----------------------------------------------------
  budget: {
    // Fallback cost per view if an ad has none set (ETB).
    defaultCostPerView: num(process.env.DEFAULT_CPV, 1),
    // Click fee as a fraction of CPV.
    clickCostRatio: num(process.env.CLICK_COST_RATIO, 0.5),
    // How long a reservation is held before the sweeper can reclaim it (minutes).
    // Should be >= watch link validity so a slow-but-genuine viewer isn't robbed.
    reservationTtlMinutes: num(process.env.RESERVATION_TTL_MINUTES, 180), // 3h
  },

  // ---- Watch link -------------------------------------------------------
  watchLink: {
    validityMinutes: num(process.env.WATCH_VALIDITY_MINUTES, 180), // 3h to watch
    purgeAfterDays: num(process.env.WATCH_PURGE_DAYS, 7),          // Mongo TTL delete
  },

  // ---- Frequency capping & rotation ------------------------------------
  frequency: {
    maxSmsPerDay: num(process.env.FREQ_MAX_SMS_DAY, 3),
    maxSmsPerWeek: num(process.env.FREQ_MAX_SMS_WEEK, 12),
    maxViewsPerDay: num(process.env.FREQ_MAX_VIEWS_DAY, 3),
    // Minimum gap between two SMS to the same subscriber (minutes).
    minGapMinutes: num(process.env.FREQ_MIN_GAP_MINUTES, 90),
    // How long an ad stays in a subscriber's "seen" set before it may rotate back (days).
    seenWindowDays: num(process.env.SEEN_WINDOW_DAYS, 14),
  },

  // ---- Eligibility scoring ("smart" suppression) -----------------------
  // Transparent, tunable weights. Score in [0,1]; below threshold => no SMS.
  eligibility: {
    minScore: num(process.env.ELIGIBILITY_MIN_SCORE, 0.35),
    weights: {
      unseenAvailability: num(process.env.W_UNSEEN, 0.35), // has fresh ads to show
      frequencyHeadroom: num(process.env.W_FREQ, 0.25),    // room under daily/weekly caps
      recency: num(process.env.W_RECENCY, 0.20),           // long enough since last SMS
      engagement: num(process.env.W_ENGAGEMENT, 0.20),     // historically completes ads
    },
    // Engagement is only judged once we have at least this many past sends.
    engagementMinSamples: num(process.env.ENGAGEMENT_MIN_SAMPLES, 4),
  },

  // ---- Pacing -----------------------------------------------------------
  pacing: {
    enabled: bool(process.env.PACING_ENABLED, true),
    // Hard ceiling on SMS dispatched per second, protecting the SMS gateway.
    gatewayMaxPerSec: num(process.env.SMS_GATEWAY_MAX_PER_SEC, 50),
    gatewayBurst: num(process.env.SMS_GATEWAY_BURST, 100),
    // The morning window each campaign's daily budget is spread across (hours).
    // Spend is smoothed so a spike can't drain a day's budget in minutes.
    spendWindowHours: num(process.env.SPEND_WINDOW_HOURS, 6),
    // If a campaign is momentarily ahead of pace, defer rather than send.
    // Candidates that can't be served before going stale are dropped.
    candidateStaleMinutes: num(process.env.CANDIDATE_STALE_MINUTES, 45),
  },

  // ---- Trigger ingestion queue -----------------------------------------
  queue: {
    // 'redis' (Redis Streams) or 'memory' (single-process dev). 'auto' picks
    // redis when REDIS_URL is set, else memory.
    driver: process.env.QUEUE_DRIVER || 'auto',
    stream: (process.env.REDIS_PREFIX || 'adplus:') + 'triggers',
    group: 'decision-workers',
    // Max candidates buffered; older ones are trimmed (they'd go stale anyway).
    maxLen: num(process.env.QUEUE_MAX_LEN, 2_000_000),
    // Workers to run in-process (server.js). Scale horizontally by running more
    // server processes; the Redis consumer group load-balances across them.
    workerConcurrency: num(process.env.WORKER_CONCURRENCY, 4),
    batchSize: num(process.env.WORKER_BATCH_SIZE, 20),
  },

  // ---- Integrations -----------------------------------------------------
  sms: {
    // 'http' | 'mock'
    driver: process.env.SMS_DRIVER || (process.env.SMS_HTTP_URL ? 'http' : 'mock'),
    httpUrl: process.env.SMS_HTTP_URL || '',
    apiKey: process.env.SMS_API_KEY || '',
    senderId: process.env.SMS_SENDER_ID || 'ADREWARD',
    timeoutMs: num(process.env.SMS_TIMEOUT_MS, 5000),
    watchBaseUrl: process.env.WATCH_BASE_URL || process.env.API_DOMAIN || 'http://localhost:3000',
    template: process.env.SMS_TEMPLATE ||
      'Watch a short ad & get {reward}. Tap: {url} (valid {validity}h)',
  },
  reward: {
    // 'http' (sync call to ETC/OCS) | 'mock'
    driver: process.env.REWARD_DRIVER || (process.env.REWARD_HTTP_URL ? 'http' : 'mock'),
    httpUrl: process.env.REWARD_HTTP_URL || '',
    apiKey: process.env.REWARD_API_KEY || '',
    timeoutMs: num(process.env.REWARD_TIMEOUT_MS, 8000),
  },
  ocs: {
    // Shared secret the OCS includes on trigger calls (header x-ocs-key).
    triggerKey: process.env.OCS_TRIGGER_KEY || '',
  },

  // ---- Fraud engine ------------------------------------------------------
  // Real-time, Redis-O(1), fail-open risk scoring. Every knob is tunable.
  fraud: {
    enabled: bool(process.env.FRAUD_ENABLED, true),
    failOpen: bool(process.env.FRAUD_FAIL_OPEN, true),

    // score → action bands
    thresholds: {
      throttle: num(process.env.FR_T_THROTTLE, 25),
      softBlock: num(process.env.FR_T_SOFT, 45),
      challenge: num(process.env.FR_T_CHALLENGE, 65),
      hardBlock: num(process.env.FR_T_HARD, 85),
    },

    // per-entity velocity token buckets (rate = req/sec, burst = bucket size)
    velocity: {
      msisdnRps: num(process.env.FR_VEL_MSISDN_RPS, 0.5), msisdnBurst: num(process.env.FR_VEL_MSISDN_BURST, 6),
      ipRps: num(process.env.FR_VEL_IP_RPS, 3), ipBurst: num(process.env.FR_VEL_IP_BURST, 30),
      devRps: num(process.env.FR_VEL_DEV_RPS, 1), devBurst: num(process.env.FR_VEL_DEV_BURST, 10),
    },

    // SIM-farm fan-out (distinct msisdns per ip/device)
    simfarm: {
      ipMax: num(process.env.FR_SF_IP_MAX, 8), ipHardMax: num(process.env.FR_SF_IP_HARD, 20),
      devMax: num(process.env.FR_SF_DEV_MAX, 5), devHardMax: num(process.env.FR_SF_DEV_HARD, 15),
      ipBurstMax: num(process.env.FR_SF_IP_BURST_MAX, 4), fanoutTtlSec: num(process.env.FR_SF_TTL, 86400),
    },

    rewardFarm: { factor: num(process.env.FR_RF_FACTOR, 2), ipHourMax: num(process.env.FR_RF_IP_HOUR, 10) },

    // watch-timing anti-fraud (needs Ad.duration_seconds)
    timing: {
      minWatchRatio: num(process.env.FR_MIN_WATCH_RATIO, 0.6),
      minProgressRatio: num(process.env.FR_MIN_PROGRESS, 0.5),
    },

    rotation: { ipMax: num(process.env.FR_ROT_IP_MAX, 4), uaMax: num(process.env.FR_ROT_UA_MAX, 3), windowSec: num(process.env.FR_ROT_WINDOW, 3600) },

    // Ethiopia bounding box [minLat,minLon,maxLat,maxLon]; impossible-travel jump
    geo: {
      bbox: (process.env.FR_GEO_BBOX || '3.4,33.0,15.0,48.0').split(',').map(Number),
      jumpKm: num(process.env.FR_GEO_JUMP_KM, 500),
      jumpWindowSec: num(process.env.FR_GEO_JUMP_WIN, 3600),
      gridDecimals: num(process.env.FR_GEO_GRID, 2),
    },

    reputation: {
      flagThreshold: num(process.env.FR_REP_FLAG, 50),
      halfLifeSec: num(process.env.FR_REP_HALFLIFE, 604800),
      bumpSoft: num(process.env.FR_REP_BUMP_SOFT, 5),
      bumpHard: num(process.env.FR_REP_BUMP_HARD, 20),
    },

    newSub: { ageSec: num(process.env.FR_NEWSUB_AGE, 86400), multiplier: num(process.env.FR_NEWSUB_MULT, 1.25) },

    autoBlacklist: {
      offenseWindowDays: num(process.env.FR_OFF_WINDOW_DAYS, 7),
      warnTtlSec: num(process.env.FR_BL_WARN_TTL, 3600),
      escalateHours: (process.env.FR_BL_ESCALATE || '6,24,72').split(',').map(Number),
      permanentAtOffense: num(process.env.FR_BL_PERM_AT, 5),
    },

    analyzer: {
      enabled: bool(process.env.FR_ANALYZER_ENABLED, true),
      intervalSec: num(process.env.FR_AN_INTERVAL, 60),
      lookbackMin: num(process.env.FR_AN_LOOKBACK, 15),
      deviceFanoutMax: num(process.env.FR_AN_DEV_FANOUT, 10),
      ipFanoutMax: num(process.env.FR_AN_IP_FANOUT, 25),
    },
  },
};
