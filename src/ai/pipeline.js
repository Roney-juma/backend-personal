/**
 * Fraud analysis pipeline entrypoint.
 * Called by the worker for every new claim: run(claimId)
 *
 * Stages (fixed order, fail-safe):
 *   1. Image forensics — deterministic, no LLM
 *   2. Data forensics  — DB rule checks, no LLM
 *   3. Narrative analysis — one Claude (fast model) call
 *   4. Score aggregation + reasoning summary
 *   5. Persist AiAnalysis doc + update claim.ai.*
 *   6. Triage routing (flag + notify)
 */
const Claim = require('../models/claim.model');
const AiAnalysis = require('../models/aiAnalysis.model');
const imageForensics = require('./analyzers/imageForensics');
const dataForensics = require('./analyzers/dataForensics');
const narrativeAnalysis = require('./analyzers/narrativeAnalysis');
const scoreEngine = require('./scoring/scoreEngine');
const triage = require('./scoring/triage');
const logger = require('../middlewheres/logger');
const { getRedisClient } = require('../queue/connection');

const run = async (claimId) => {
  let claim;
  try {
    claim = await Claim.findById(claimId);
    if (!claim) { logger.warn(`[pipeline] claim ${claimId} not found`); return; }

    // Mark as in-progress
    await Claim.findByIdAndUpdate(claimId, { 'ai.status': 'analyzing' });

    const signals = [];
    const checksRun = [];
    let tokensUsed = 0;
    let kesSpent = 0;

    // ── Stage 1: Image forensics ─────────────────────────────────────────────
    try {
      const imgResult = await imageForensics.run(claim);
      signals.push(...imgResult.signals);
      checksRun.push(...imgResult.checksRun);
    } catch (err) {
      logger.warn(`[pipeline] imageForensics failed for ${claimId}: ${err.message}`);
      signals.push({ type: 'analyzer_error', severity: 'low', explanation: `Image forensics error: ${err.message}`, source: 'image_forensics' });
    }

    // ── Stage 2: Data / DB forensics ─────────────────────────────────────────
    try {
      const dataResult = await dataForensics.run(claim);
      signals.push(...dataResult.signals);
      checksRun.push(...dataResult.checksRun);
    } catch (err) {
      logger.warn(`[pipeline] dataForensics failed for ${claimId}: ${err.message}`);
    }

    // ── Stage 3: Narrative analysis ──────────────────────────────────────────
    try {
      const narResult = await narrativeAnalysis.run(claim);
      signals.push(...narResult.signals);
      tokensUsed += narResult.tokensUsed;
      kesSpent += narResult.kesSpent;
      if (narResult.signals.length) checksRun.push('narrative_analysis');
    } catch (err) {
      logger.warn(`[pipeline] narrativeAnalysis failed for ${claimId}: ${err.message}`);
    }

    // ── Stage 4: Score + reasoning ───────────────────────────────────────────
    const { score, band, reasoning, tokensUsed: rTok, kesSpent: rKes } =
      await scoreEngine.aggregate(signals, claim);
    tokensUsed += rTok;
    kesSpent += rKes;

    // ── Stage 5: Persist ─────────────────────────────────────────────────────
    const analysis = await AiAnalysis.create({
      claimId: claim._id,
      company: claim.company,
      signals,
      score,
      band,
      reasoning,
      checksRun,
      modelVersions: { fast: process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5-20251001' },
      tokensUsed,
      kesSpent,
    });

    await Claim.findByIdAndUpdate(claimId, {
      'ai.status': 'analyzed',
      'ai.riskScore': score,
      'ai.riskBand': band,
      'ai.analysisId': analysis._id,
      'ai.analyzedAt': new Date(),
    });

    logger.info(`[pipeline] claim ${claimId} analyzed — score=${score} band=${band} signals=${signals.length} tokens=${tokensUsed} KES=${kesSpent.toFixed(2)}`);

    // ── Stage 6: Triage ──────────────────────────────────────────────────────
    const freshClaim = await Claim.findById(claimId);
    await triage.route(freshClaim, band, { score, signals, reasoning });

    // Notify the main app process so Socket.IO can push to the admin portal
    const redis = getRedisClient();
    if (redis) {
      redis.publish('claim:ai_updated', JSON.stringify({
        claimId: claimId.toString(),
        score,
        band,
        status: 'analyzed',
      })).catch(err => logger.warn(`[pipeline] Redis publish failed: ${err.message}`));
    }

  } catch (err) {
    logger.error(`[pipeline] fatal error for claim ${claimId}: ${err.message}`);
    try {
      await Claim.findByIdAndUpdate(claimId, { 'ai.status': 'error' });
    } catch (_) {}
    throw err; // let BullMQ retry
  }
};

module.exports = { run };
