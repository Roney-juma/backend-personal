const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Claim = require('../models/claim.model');
const legalConfig = require('./legalConfig.service');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const { TP_CLAIM_TYPES } = require('../constants/legal.constants');

/**
 * The legal-risk engine.
 *
 * Scores how BADLY A THIRD-PARTY EXPOSURE IS LIKELY TO GO — not whether anyone
 * is lying. That distinction matters: the fraud engine in src/ai/scoring asks
 * "is this claim genuine?", and this asks "given that it is genuine, how
 * expensive and contested is it going to get?". A fatal accident with clear
 * liability scores CRITICAL here and clean there, and both are correct.
 *
 * Deterministic and rule-based, with no model call. A referral threshold that
 * moved because a language model was feeling different today would be
 * indefensible, and every factor here is a fact already recorded on the file.
 *
 * Weights and thresholds are per-tenant (spec §18 gives illustrative weights;
 * the insurer's own are what apply).
 */

/**
 * Evaluate one third-party exposure.
 *
 * @param {Object} tpc     ThirdPartyClaim (document or lean object)
 * @param {Object} [ctx]   { claim, siblingCount } to avoid re-querying
 * @returns {Promise<{ score, band, flags, weights }>}
 */
async function evaluate(tpc, ctx = {}) {
  const config = await legalConfig.get(tpc.company);
  const weights = config.riskWeights || {};
  const thresholds = config.riskThresholds || { medium: 30, high: 55, critical: 75 };

  const claim = ctx.claim || (await Claim.findById(tpc.claim).select('company fraud incidentDetails').lean());
  const siblingCount =
    ctx.siblingCount ??
    (await ThirdPartyClaim.countDocuments({ claim: tpc.claim, _id: { $ne: tpc._id } }));

  const flags = [];
  const raise = (code, label, weightKey, detail) => {
    const weight = weights[weightKey];
    if (!weight) return;
    flags.push({ code, label, score: Math.round(weight * 100), detail });
  };

  // ── Severity of the injury itself ────────────────────────────────────────
  if (tpc.claimType === TP_CLAIM_TYPES.FATAL || tpc.injury?.deceased) {
    raise('fatality', 'Fatal claim', 'fatality', 'Dependency and funeral heads apply; quantum is rarely small.');
  } else if (
    tpc.claimType === TP_CLAIM_TYPES.BODILY_INJURY ||
    tpc.claimType === TP_CLAIM_TYPES.MEDICAL_EXPENSES
  ) {
    raise('bodily_injury', 'Bodily injury', 'bodily_injury', 'Injury claims run longer and cost more than property.');
  }

  // Permanent disability is not a separate configured weight but materially
  // changes quantum, so it reinforces the injury flag rather than adding one.
  if ((tpc.injury?.disabilityPercent || 0) >= 20) {
    const existing = flags.find((f) => f.code === 'bodily_injury');
    if (existing) {
      existing.score = Math.round(existing.score * 1.3);
      existing.detail += ` Assessed disability of ${tpc.injury.disabilityPercent}%.`;
    }
  }

  // ── Money ────────────────────────────────────────────────────────────────
  const exposureMinor = tpc.exposure?.cappedMinor || tpc.quantum?.demandedMinor || 0;
  const highValueThresholdMinor = money.toMinor(
    config.riskHighValueThreshold ?? 2000000
  );
  if (exposureMinor >= highValueThresholdMinor) {
    raise(
      'high_claim_value',
      'High value',
      'high_claim_value',
      `${money.formatMinor(exposureMinor)} exposure.`
    );
  }

  // ── Contest ──────────────────────────────────────────────────────────────
  if (tpc.liability?.disputed) {
    raise('liability_dispute', 'Liability disputed', 'liability_dispute', 'Disputed liability drives litigation.');
  }
  if (tpc.opposingAdvocate?.name || tpc.opposingAdvocate?.firm) {
    raise(
      'advocate_demand',
      'Claimant represented',
      'advocate_demand',
      `Represented by ${tpc.opposingAdvocate.firm || tpc.opposingAdvocate.name}.`
    );
  }

  // ── Cover ────────────────────────────────────────────────────────────────
  // A claim above the policy limit means the insured personally carries the
  // excess, which reliably turns into a dispute with our own insured.
  if (tpc.exposure?.limitApplied) {
    raise(
      'coverage_dispute',
      'Above policy limit',
      'coverage_dispute',
      `${money.formatMinor(tpc.exposure.excessOfLimitMinor)} falls outside cover.`
    );
  }

  // ── Multiple claimants ───────────────────────────────────────────────────
  if (siblingCount > 0) {
    raise(
      'multiple_claimants',
      `${siblingCount + 1} claimants on one accident`,
      'multiple_claimants',
      'Aggregate limits and consolidated proceedings become live.'
    );
  }

  // ── Fraud ────────────────────────────────────────────────────────────────
  // The one place the two engines meet: a claim the fraud pipeline has flagged
  // is likelier to be contested, whatever the outcome of that investigation.
  if (claim?.fraud?.suspected || claim?.fraud?.riskLevel === 'high') {
    raise(
      'fraud_indicator',
      'Fraud flagged on the claim',
      'fraud_indicator',
      'Repudiation on fraud grounds is frequently challenged.'
    );
  }

  const raw = flags.reduce((acc, f) => acc + f.score, 0);
  const score = Math.min(100, raw);

  let band = 'low';
  if (score >= thresholds.critical) band = 'critical';
  else if (score >= thresholds.high) band = 'high';
  else if (score >= thresholds.medium) band = 'medium';

  return { score, band, flags, thresholds };
}

/**
 * Evaluate and persist, returning whether the band changed.
 *
 * The caller decides what to do about an escalation — this deliberately does not
 * refer anything itself, because a scoring function with side effects is one
 * nobody can safely re-run.
 */
async function score(tpcId, ctx = {}) {
  const tpc = await ThirdPartyClaim.findById(tpcId);
  if (!tpc) return null;

  const previousBand = tpc.riskLevel;
  const result = await evaluate(tpc, ctx);

  tpc.riskScore = result.score;
  tpc.riskLevel = result.band;
  tpc.riskFlags = result.flags.map((f) => ({
    code: f.code,
    label: f.label,
    score: f.score,
    detectedAt: new Date(),
  }));
  await tpc.save();

  return { ...result, previousBand, escalated: bandRank(result.band) > bandRank(previousBand) };
}

const bandRank = (b) => ({ low: 0, medium: 1, high: 2, critical: 3 })[b] ?? 0;

/**
 * Score every open exposure for a tenant and report what escalated.
 *
 * Run nightly. Returns the escalations rather than acting on them, so the caller
 * (or a human) decides whether a HIGH band actually warrants a referral — spec
 * §18 makes HIGH "mandatory legal referral", but that is a tenant policy and not
 * something this function should assume.
 */
async function rescoreOpen({ company, limit = 1000 }) {
  const claims = await ThirdPartyClaim.find({
    company,
    status: { $nin: ['settled', 'paid', 'closed', 'time_barred'] },
  })
    .limit(limit)
    .select('_id claim')
    .lean();

  // Sibling counts in one pass rather than one query per exposure.
  const byClaim = {};
  for (const c of claims) {
    byClaim[String(c.claim)] = (byClaim[String(c.claim)] || 0) + 1;
  }

  const escalations = [];
  let scored = 0;

  for (const c of claims) {
    try {
      const result = await score(c._id, { siblingCount: (byClaim[String(c.claim)] || 1) - 1 });
      scored += 1;
      if (result?.escalated) {
        escalations.push({
          thirdPartyClaim: c._id,
          from: result.previousBand,
          to: result.band,
          score: result.score,
          flags: result.flags.map((f) => f.label),
        });
      }
    } catch (err) {
      logger.error(`[legal-risk] scoring failed for ${c._id}: ${err.message}`);
    }
  }

  if (escalations.length) {
    logger.info(`[legal-risk] ${escalations.length} of ${scored} exposures escalated a risk band`);
  }
  return { scored, escalations };
}

/**
 * Explain a score in plain words, for the UI.
 *
 * Written out rather than left as a number because a bare 78/100 tells a legal
 * officer nothing about what to do — the flags are the actionable part.
 */
function explain(result) {
  if (!result?.flags?.length) {
    return 'Nothing on this claim currently raises its legal risk above routine.';
  }
  const top = [...result.flags].sort((a, b) => b.score - a.score).slice(0, 3);
  return (
    `Scored ${result.score}/100 (${result.band}). Principally: ` +
    top.map((f) => f.label.toLowerCase()).join(', ') + '.'
  );
}

module.exports = { evaluate, score, rescoreOpen, explain };
