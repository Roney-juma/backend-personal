const ApiError = require('../utils/ApiError');
const money = require('../utils/money');
const { TP_CLAIM_TYPES } = require('../constants/legal.constants');

/**
 * Turns a third-party claim's quantum and liability into an exposure figure.
 *
 * Three steps, in order, and the order matters:
 *   1. GROSS         — what the claim is worth in total
 *   2. APPORTIONED   — gross x our insured's share of the fault
 *   3. CAPPED        — apportioned, capped at the policy limit for its head
 *
 * Everything here is pure: it takes plain values and returns plain values, with
 * no database access. That keeps the arithmetic testable in isolation, which
 * matters because these numbers drive reserves, settlement authority and the
 * management dashboard — a quiet rounding bug here is expensive and invisible.
 *
 * All amounts are integer minor units (see utils/money.js).
 */

/**
 * Which liability limit answers a claim of this type.
 *
 * Bodily injury and property damage are separately limited on a motor policy —
 * commonly unlimited for injury and capped for property — so applying the wrong
 * one either under-reserves a serious injury or fails to warn on a property
 * claim that has already exhausted cover.
 */
function limitHeadFor(claimType) {
  switch (claimType) {
    case TP_CLAIM_TYPES.PROPERTY_DAMAGE:
    case TP_CLAIM_TYPES.LOSS_OF_USE:
      return 'propertyDamageMinor';
    case TP_CLAIM_TYPES.BODILY_INJURY:
    case TP_CLAIM_TYPES.FATAL:
    case TP_CLAIM_TYPES.MEDICAL_EXPENSES:
      return 'bodilyInjuryMinor';
    default:
      return 'propertyDamageMinor';
  }
}

/**
 * Total the quantum heads.
 *
 * Prefers the assessor's own figure when they have given one: `ourAssessment` is
 * a considered view that may deliberately differ from the sum of the parts.
 * Falls back to the heads, and only then to what the claimant demanded — a
 * demand is the other side's number, so it is the least reliable basis for a
 * reserve and is used only when nothing better exists.
 *
 * @param {Object} quantum
 * @returns {{ grossMinor: number, basis: string }}
 */
function grossOf(quantum = {}) {
  if (Number.isInteger(quantum.ourAssessmentMinor) && quantum.ourAssessmentMinor > 0) {
    return { grossMinor: quantum.ourAssessmentMinor, basis: 'our_assessment' };
  }

  const heads = [
    quantum.generalDamagesMinor,
    quantum.specialDamagesMinor,
    quantum.lossOfEarningsMinor,
    quantum.futureMedicalMinor,
    quantum.dependencyMinor,
    quantum.funeralExpensesMinor,
    quantum.claimantCostsMinor,
  ].filter((v) => Number.isInteger(v) && v > 0);

  if (heads.length) {
    return { grossMinor: money.sumMinor(heads), basis: 'sum_of_heads' };
  }

  if (Number.isInteger(quantum.demandedMinor) && quantum.demandedMinor > 0) {
    return { grossMinor: quantum.demandedMinor, basis: 'demanded' };
  }

  return { grossMinor: 0, basis: 'unassessed' };
}

/**
 * Validate a liability apportionment and return our insured's effective share.
 *
 * The three shares must account for the whole of the fault. Allowing them not to
 * would let a claim be apportioned 60/20 with the missing 20% silently falling
 * to nobody, which reads as a smaller exposure than it is.
 *
 * When only contributory and other-party shares are given, our share is inferred
 * as the remainder — which is how these are usually recorded in practice.
 *
 * @param {Object} liability
 * @returns {{ sharePercent: number, assessed: boolean }}
 */
function effectiveShare(liability = {}) {
  const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

  const contributory = has(liability.contributoryPercent) ? Number(liability.contributoryPercent) : 0;
  const others = has(liability.otherPartiesPercent) ? Number(liability.otherPartiesPercent) : 0;

  if (!has(liability.insuredSharePercent)) {
    // Nothing assessed at all — exposure is computed at 100% as the prudent
    // default, and flagged unassessed so the UI can say so.
    if (!contributory && !others) return { sharePercent: 100, assessed: false };
    const inferred = 100 - contributory - others;
    if (inferred < 0) {
      throw new ApiError(400, 'Contributory and other-party shares exceed 100%');
    }
    return { sharePercent: inferred, assessed: true };
  }

  const insured = Number(liability.insuredSharePercent);
  const total = insured + contributory + others;
  // A small tolerance for figures recorded to one decimal place.
  if (Math.abs(total - 100) > 0.01) {
    throw new ApiError(
      400,
      `Liability shares must total 100% — insured ${insured}% + contributory ${contributory}% + ` +
      `others ${others}% = ${total}%`
    );
  }
  return { sharePercent: insured, assessed: true };
}

/**
 * Compute one third-party claim's exposure.
 *
 * @param {Object} params
 * @param {Object} params.quantum
 * @param {Object} params.liability
 * @param {string} params.claimType
 * @param {Object} [params.limits]   policy liabilityLimits; null values = unlimited
 * @returns {Object} exposure
 */
function computeExposure({ quantum, liability, claimType, limits = {} }) {
  const { grossMinor, basis } = grossOf(quantum);
  const { sharePercent, assessed } = effectiveShare(liability);

  const afterApportionmentMinor = money.applyPercent(grossMinor, sharePercent);

  const head = limitHeadFor(claimType);
  const limitMinor = limits?.[head] ?? null;
  const { amountMinor, limitApplied, excessMinor } = money.capAtLimit(afterApportionmentMinor, limitMinor);

  return {
    grossMinor,
    grossBasis: basis,
    liabilitySharePercent: sharePercent,
    liabilityAssessed: assessed,
    afterApportionmentMinor,
    cappedMinor: amountMinor,
    limitHead: head,
    limitMinor,
    limitApplied,
    // The part of the claim the policy does NOT answer for. This is the
    // insured's own exposure, and surfacing it early is one of the more
    // valuable things this module does.
    excessOfLimitMinor: excessMinor,
    computedAt: new Date(),
  };
}

/**
 * Aggregate every third-party claimant on one accident against the policy's
 * AGGREGATE limit.
 *
 * A per-claimant view can look comfortable while the accident as a whole is well
 * over cover: four injured passengers each inside the per-head limit can still
 * exhaust an aggregate between them. The aggregate bites on the accident, so it
 * has to be measured there.
 *
 * @param {Array<Object>} exposures  each { cappedMinor, thirdPartyClaim?, claimType? }
 * @param {Object} [limits]
 * @returns {Object}
 */
function computeAccidentErosion(exposures = [], limits = {}) {
  const totalMinor = money.sumMinor(exposures.map((e) => e.cappedMinor || 0));
  const aggregateMinor = limits?.aggregateMinor ?? null;

  const { amountMinor, limitApplied, excessMinor } = money.capAtLimit(totalMinor, aggregateMinor);

  // How much of the aggregate is gone, for the "cover remaining" indicator.
  const remainingMinor = aggregateMinor === null ? null : Math.max(0, aggregateMinor - totalMinor);
  // Deliberately NOT clamped at 100. An accident sitting at 115% of the
  // aggregate is precisely what this figure exists to surface — capping it would
  // make a breached limit look identical to one exactly exhausted.
  const erosionPercent = aggregateMinor
    ? Math.round((totalMinor / aggregateMinor) * 10000) / 100
    : 0;

  return {
    claimantCount: exposures.length,
    totalExposureMinor: totalMinor,
    aggregateLimitMinor: aggregateMinor,
    coveredMinor: amountMinor,
    remainingMinor,
    erosionPercent,
    limitEroded: limitApplied,
    excessOfLimitMinor: excessMinor,
    computedAt: new Date(),
  };
}

/**
 * Present an exposure for the API, converting minor units to major at the edge.
 * The `*Minor` fields are kept alongside so a client that wants exact arithmetic
 * still has it.
 */
function presentExposure(exposure) {
  if (!exposure) return null;
  return {
    ...exposure,
    gross: money.toMajor(exposure.grossMinor),
    afterApportionment: money.toMajor(exposure.afterApportionmentMinor),
    capped: money.toMajor(exposure.cappedMinor),
    excessOfLimit: money.toMajor(exposure.excessOfLimitMinor),
    limit: exposure.limitMinor === null ? null : money.toMajor(exposure.limitMinor),
    formatted: {
      gross: money.formatMinor(exposure.grossMinor),
      capped: money.formatMinor(exposure.cappedMinor),
      excessOfLimit: money.formatMinor(exposure.excessOfLimitMinor),
    },
  };
}

module.exports = {
  computeExposure,
  computeAccidentErosion,
  presentExposure,
  grossOf,
  effectiveShare,
  limitHeadFor,
};
