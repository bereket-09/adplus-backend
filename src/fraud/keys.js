/**
 * keys.js — Central Redis key builders for the fraud engine. Single source of
 * truth so the hot-path signals and the async analyzer never disagree on a key.
 * The `adplus:` prefix is applied by the ioredis client; here we only add `fr:`.
 */
const P = 'fr:';

module.exports = {
  velMsisdn: (m) => `${P}tb:msisdn:${m}`,
  velIp: (ip) => `${P}tb:ip:${ip}`,
  velDev: (fp) => `${P}tb:dev:${fp}`,

  fanIp: (ip) => `${P}fan:ip:${ip}`,          // set of msisdns seen on an IP (24h)
  fanIpShort: (ip) => `${P}fan:ip:short:${ip}`,// set of msisdns on an IP (10m)
  fanDev: (fp) => `${P}fan:dev:${fp}`,         // set of msisdns on a device fp (24h)
  fanIpIndex: `${P}fan:ip:index`,             // set of active IPs (for analyzer)
  fanDevIndex: `${P}fan:dev:index`,           // set of active device fps

  rewardDev: (fp) => `${P}rf:dev:${fp}`,       // completions per device / day
  rewardIpHour: (ip) => `${P}rf:ip:1h:${ip}`,  // completions per IP / hour

  replayKey: (token, stage) => `${P}rk:${token}:${stage}`,
  replayTuple: (token) => `${P}rt:${token}`,

  rotIp: (m) => `${P}rot:msisdn:${m}`,         // distinct IPs per msisdn (1h)
  rotUa: (m) => `${P}uarot:msisdn:${m}`,       // distinct UAs per msisdn (1h)

  geoLast: (m) => `${P}geo:msisdn:${m}`,       // last {bucket,ts} per msisdn
  firstSeen: (m) => `${P}seen:first:${m}`,     // first-seen epoch per msisdn

  repScore: (type, id) => `${P}rep:score:${type}:${id}`,
  repTs: (type, id) => `${P}rep:ts:${type}:${id}`,
  repIndex: (type) => `${P}rep:index:${type}`, // set of scored entity ids

  offense: (type, value) => `${P}off:${type}:${value}`,
  analyzerLock: `${P}lock:analyzer`,
  prefix: P,
};
