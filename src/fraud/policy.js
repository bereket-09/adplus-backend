/**
 * policy.js — Pure mapping from a composite risk score to an action band.
 * Actions: allow | throttle | soft_block | challenge | hard_block.
 */
const cfg = require('../config/engine');

function scoreToAction(score) {
  const t = cfg.fraud.thresholds;
  if (score >= t.hardBlock) return 'hard_block';
  if (score >= t.challenge) return 'challenge';
  if (score >= t.softBlock) return 'soft_block';
  if (score >= t.throttle) return 'throttle';
  return 'allow';
}

// Reward-bearing stages must be denied at soft_block and above; read-only stages
// (trigger/decide/open/start) only truly stop at challenge/hard_block.
function isDenied(action, stage) {
  const rewardBearing = stage === 'complete' || stage === 'click';
  if (action === 'hard_block' || action === 'challenge') return true;
  if (action === 'soft_block') return rewardBearing;
  return false;
}

module.exports = { scoreToAction, isDenied };
