/**
 * Vehicle-continuity pipeline entrypoint.
 * Called by the worker when a downstream report is submitted:
 *   runStageCheck(claimId, stage)   stage ∈ 'assessment' | 'garage' | 'reassessment'
 *
 * Compares the stage's vehicle against the claimant baseline, persists a
 * standalone AiAnalysis record (kind: 'vehicle_continuity'), and routes it for
 * human review. It NEVER changes claim.status — flag + notify only.
 */
const Claim = require('../models/claim.model');
const AiAnalysis = require('../models/aiAnalysis.model');
const vehicleContinuity = require('./analyzers/vehicleContinuity');
const { FINGERPRINT_PROMPT_VERSION } = require('./analyzers/vehicleIdentity');
const scoreEngine = require('./scoring/scoreEngine');
const triage = require('./scoring/triage');
const logger = require('../middlewheres/logger');
const { getRedisClient } = require('../queue/connection');

const runStageCheck = async (claimId, stage) => {
  const claim = await Claim.findById(claimId);
  if (!claim) { logger.warn(`[continuity] claim ${claimId} not found`); return; }

  const { signals, checksRun, verdict, tokensUsed = 0, kesSpent = 0 } =
    await vehicleContinuity.run(claim, stage);

  // Reuse the shared scorer so continuity signals feed the same 0–100 risk band.
  const { score, band, reasoning, tokensUsed: rTok = 0, kesSpent: rKes = 0 } =
    await scoreEngine.aggregate(signals, claim);

  const summary = reasoning ||
    `Vehicle continuity (${stage}): ${verdict.sameVehicle} — ${verdict.confidence} confidence.`;

  const analysis = await AiAnalysis.create({
    claimId: claim._id,
    companyId: claim.customerId,
    kind: 'vehicle_continuity',
    stage,
    signals,
    score,
    band,
    reasoning: summary,
    verdict,
    checksRun,
    modelVersions: {
      fast: process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5',
      prompt: FINGERPRINT_PROMPT_VERSION,
    },
    tokensUsed: tokensUsed + rTok,
    kesSpent: kesSpent + rKes,
  });

  logger.info(`[continuity] claim ${claimId} stage=${stage} verdict=${verdict.sameVehicle} score=${score} band=${band} signals=${signals.length}`);

  // Flag + notify for review — never auto-decide or change claim.status.
  await triage.route(claim, band, { score, signals, reasoning: summary });

  const redis = getRedisClient();
  if (redis) {
    redis.publish('claim:continuity_updated', JSON.stringify({
      claimId: String(claimId), stage, verdict: verdict.sameVehicle, score, band,
    })).catch((err) => logger.warn(`[continuity] Redis publish failed: ${err.message}`));
  }

  return analysis;
};

module.exports = { runStageCheck };
