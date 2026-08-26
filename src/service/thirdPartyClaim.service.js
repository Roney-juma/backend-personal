const mongoose = require('mongoose');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const legalConfig = require('./legalConfig.service');
const legalLedger = require('./legalLedger.service');
const exposureService = require('./legalExposure.service');
const limitation = require('./limitation.service');
const { TP_CLAIM_TYPES } = require('../constants/legal.constants');

/**
 * The third-party claim register — the working core of the Legal module.
 *
 * A ThirdPartyClaim is one person claiming against our insured. It is created
 * the moment a demand or injury is known, long before any suit, because most of
 * these settle without litigation and an insurer that only registers claimants
 * once they are in court has no register of its largest liability.
 */

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a third-party claimant against an existing accident.
 *
 * @param {Object} data
 * @param {*}      data.claim        the accident (Claim._id)
 * @param {string} data.claimType
 * @param {Object} data.party
 * @param {Object} [actor]
 * @returns {Promise<Object>}
 */
async function register(data, actor = null) {
  const claim = await Claim.findById(data.claim);
  if (!claim) throw new ApiError(404, 'Claim not found');

  if (!data.party?.name) {
    throw new ApiError(400, 'A third-party claim needs the claimant\'s name');
  }
  if (!Object.values(TP_CLAIM_TYPES).includes(data.claimType)) {
    throw new ApiError(400, `Unknown third-party claim type: ${data.claimType}`);
  }

  // Tenant is taken from the accident, never from the request body — the same
  // discipline the rest of the platform uses.
  const company = claim.company;
  if (!company) {
    throw new ApiError(400, 'That claim has no company — cannot scope a third-party claim to a tenant');
  }

  const referenceNumber = await Counter.nextReference({ prefix: 'TPC', company });

  const tpc = new ThirdPartyClaim({
    ...data,
    referenceNumber,
    claim: claim._id,
    company,
    policyNumber: data.policyNumber || claim.policyRef?.policyNumber,
    registeredBy: actor?._id || actor?.id || null,
    handler: data.handler || actor?._id || actor?.id || null,
    firstNotifiedAt: data.firstNotifiedAt || new Date(),
  });

  // Every claim gets a clock at registration. No exceptions — a claim without a
  // limitation date is invisible to the one sweep that matters most.
  await limitation.attachLimitation(tpc, {
    accrualDate:
      data.accrualDate ||
      (tpc.injury?.deceased && tpc.injury?.dateOfDeath) ||
      claim.incidentDetails?.date,
  });

  await recomputeExposure(tpc, { claim });
  await tpc.save();

  await limitation.syncLimitationEvent(tpc, actor);
  await tpc.save();

  // Seed the reserve from the tenant's own reserving policy, if they have loaded
  // one and the injury has been coded.
  await seedReserve(tpc, actor).catch((err) =>
    logger.warn(`[tpc] reserve seeding failed for ${tpc.referenceNumber}: ${err.message}`)
  );

  await recomputeClaimRollup(claim._id);

  logger.info(
    `[tpc] registered ${tpc.referenceNumber} (${tpc.claimType}) on claim ${claim._id} — ` +
    `time-bar ${tpc.limitation.expiresAt?.toISOString().slice(0, 10)}`
  );
  return tpc;
}

/**
 * Seed the reserve from the tenant's reserving schedule.
 *
 * When the tenant has not loaded a schedule, or the injury is uncoded, this does
 * nothing rather than reserving a number we invented — a wrong reserve is worse
 * than an obviously missing one, because it looks answered.
 */
async function seedReserve(tpc, actor = null) {
  if (tpc.reserve?.currentMinor > 0) return null;

  const code = tpc.injury?.injuryCode || (tpc.claimType === TP_CLAIM_TYPES.PROPERTY_DAMAGE ? 'property_only' : null);
  if (!code) return null;

  const band = await legalConfig.reservingBand(tpc.company, code);
  if (!band?.defaultMinor) return null;

  return setReserve(
    tpc._id,
    { amountMinor: band.defaultMinor, scheduleCode: code, seeded: true },
    actor
  );
}

// ── Assessment ───────────────────────────────────────────────────────────────

/**
 * Record the liability apportionment.
 *
 * One of the two numbers that drives every downstream figure, which is why it is
 * a permissioned action of its own (ASSESS_LIABILITY) rather than part of a
 * general update.
 */
async function assessLiability(tpcId, liability, actor = null) {
  const tpc = await ThirdPartyClaim.findById(tpcId);
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  // Validate before persisting — effectiveShare throws on shares that do not
  // account for the whole of the fault.
  exposureService.effectiveShare(liability);

  const before = tpc.liability?.toObject ? tpc.liability.toObject() : { ...tpc.liability };

  tpc.liability = {
    ...before,
    ...liability,
    assessedBy: actor?._id || actor?.id || null,
    assessedAt: new Date(),
  };

  await recomputeExposure(tpc);
  await tpc.save();
  await recomputeClaimRollup(tpc.claim);

  return { tpc, before, after: tpc.liability };
}

/**
 * Record the quantum assessment — what the claim is worth, broken down.
 *
 * Amounts arrive in major units from the API and are converted here, at the
 * edge, exactly once.
 */
async function assessQuantum(tpcId, quantum, actor = null) {
  const tpc = await ThirdPartyClaim.findById(tpcId);
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  const before = tpc.quantum?.toObject ? tpc.quantum.toObject() : { ...tpc.quantum };

  const HEADS = [
    'generalDamages', 'specialDamages', 'lossOfEarnings', 'futureMedical',
    'dependency', 'funeralExpenses', 'claimantCosts', 'demanded', 'ourAssessment',
  ];

  const next = { ...before };
  for (const head of HEADS) {
    const minorKey = `${head}Minor`;
    if (quantum[minorKey] !== undefined) {
      next[minorKey] = quantum[minorKey];
    } else if (quantum[head] !== undefined && quantum[head] !== null && quantum[head] !== '') {
      next[minorKey] = money.toMinor(quantum[head]);
    }
  }
  if (quantum.basis !== undefined) next.basis = quantum.basis;
  if (quantum.comparables !== undefined) next.comparables = quantum.comparables;

  next.assessedBy = actor?._id || actor?.id || null;
  next.assessedAt = new Date();

  tpc.quantum = next;

  await recomputeExposure(tpc);
  await tpc.save();
  await recomputeClaimRollup(tpc.claim);

  return { tpc, before, after: tpc.quantum };
}

// ── Reserve ──────────────────────────────────────────────────────────────────

/**
 * Set or revise the reserve.
 *
 * The reserve on the document is only a cached head — the movement itself is a
 * ledger posting, so the history of what was reserved and when survives every
 * later revision.
 *
 * Departing from the company's own reserving schedule requires a reason; the
 * route additionally gates it behind OVERRIDE_RESERVE_SCHEDULE.
 */
async function setReserve(tpcId, { amountMinor, amount, scheduleCode, reason, seeded = false }, actor = null) {
  const tpc = await ThirdPartyClaim.findById(tpcId);
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  const targetMinor = Number.isInteger(amountMinor) ? amountMinor : money.toMinor(amount);
  if (targetMinor < 0) throw new ApiError(400, 'A reserve cannot be negative');

  const currentMinor = tpc.reserve?.currentMinor || 0;
  const deltaMinor = targetMinor - currentMinor;
  if (deltaMinor === 0) return tpc;

  // Is this a departure from the schedule?
  const code = scheduleCode || tpc.reserve?.scheduleCode;
  let overridden = false;
  if (code && !seeded) {
    const band = await legalConfig.reservingBand(tpc.company, code);
    if (band && (targetMinor < band.minMinor || (band.maxMinor > 0 && targetMinor > band.maxMinor))) {
      overridden = true;
      if (!reason || !String(reason).trim()) {
        throw new ApiError(
          400,
          `${money.formatMinor(targetMinor)} is outside the ${band.label} band ` +
          `(${money.formatMinor(band.minMinor)}–${money.formatMinor(band.maxMinor)}) — a reason is required`
        );
      }
    }
  }

  // The posting is the fact; the field is the cache.
  await legalLedger.post(
    {
      company: tpc.company,
      claim: tpc.claim,
      thirdPartyClaim: tpc._id,
      legalCase: tpc.legalCase,
      entryType: currentMinor === 0 ? 'reserve_set' : 'reserve_adjust',
      amountMinor: currentMinor === 0 ? targetMinor : deltaMinor,
      reserveBucket: 'claim',
      description:
        (seeded ? 'Seeded from reserving schedule' : reason || 'Reserve revised') +
        (code ? ` [${code}]` : ''),
    },
    actor
  );

  tpc.reserve = {
    currentMinor: targetMinor,
    scheduleCode: code,
    seededFromMinor: seeded ? targetMinor : tpc.reserve?.seededFromMinor,
    overridden: overridden || tpc.reserve?.overridden || false,
    overrideReason: overridden ? reason : tpc.reserve?.overrideReason,
    lastChangedBy: actor?._id || actor?.id || null,
    lastChangedAt: new Date(),
  };

  await tpc.save();
  await recomputeClaimRollup(tpc.claim);

  logger.info(
    `[tpc] reserve on ${tpc.referenceNumber}: ${money.formatMinor(currentMinor)} → ` +
    `${money.formatMinor(targetMinor)}${overridden ? ' (OVERRIDE)' : ''}`
  );
  return tpc;
}

// ── Exposure ─────────────────────────────────────────────────────────────────

/**
 * Recompute one claim's exposure from its current quantum, liability and the
 * policy limits in force. Mutates the document; the caller saves.
 */
async function recomputeExposure(tpc, { claim = null } = {}) {
  const limits = await resolveLimits(tpc, claim);

  tpc.exposure = exposureService.computeExposure({
    quantum: tpc.quantum?.toObject ? tpc.quantum.toObject() : tpc.quantum || {},
    liability: tpc.liability?.toObject ? tpc.liability.toObject() : tpc.liability || {},
    claimType: tpc.claimType,
    limits,
  });

  return tpc.exposure;
}

/**
 * Find the liability limits that answer this claim.
 *
 * Resolved from the policy on the customer's book record, matched by policy
 * number where known and otherwise by the vehicle registration on the accident.
 * Returns empty limits rather than throwing when the book has not been loaded
 * with cover terms — the exposure is then uncapped, which is the prudent
 * direction, and the seed script reports the gap.
 */
async function resolveLimits(tpc, claim = null) {
  try {
    const accident = claim || (await Claim.findById(tpc.claim).lean());
    if (!accident?.customerId) return {};

    const customer = await Customer.findById(accident.customerId)
      .select('policies policyNumber')
      .lean();
    if (!customer) return {};

    const policyNumber = tpc.policyNumber || accident.policyRef?.policyNumber || customer.policyNumber;
    const registrations = (accident.vehiclesInvolved || [])
      .map((v) => String(v.licensePlate || '').toUpperCase().replace(/\s/g, ''))
      .filter(Boolean);

    const policy =
      (customer.policies || []).find((p) => p.policyNumber === policyNumber) ||
      (customer.policies || []).find((p) =>
        registrations.includes(String(p.vehicle?.registration || '').toUpperCase().replace(/\s/g, ''))
      );

    return policy?.liabilityLimits || {};
  } catch (err) {
    logger.warn(`[tpc] could not resolve policy limits for ${tpc.referenceNumber}: ${err.message}`);
    return {};
  }
}

/**
 * Aggregate exposure across every claimant on one accident, against the policy's
 * aggregate limit. This is where limit erosion actually shows up.
 */
async function accidentExposure(claimId) {
  const claim = await Claim.findById(claimId).lean();
  if (!claim) throw new ApiError(404, 'Claim not found');

  const claimants = await ThirdPartyClaim.find({
    claim: claimId,
    status: { $ne: 'closed' },
  }).lean();

  const limits = claimants.length
    ? await resolveLimits(claimants[0], claim)
    : {};

  const erosion = exposureService.computeAccidentErosion(
    claimants.map((c) => c.exposure || {}),
    limits
  );

  return {
    claim: claimId,
    ...erosion,
    claimants: claimants.map((c) => ({
      _id: c._id,
      referenceNumber: c.referenceNumber,
      party: c.party?.name,
      claimType: c.claimType,
      status: c.status,
      exposureMinor: c.exposure?.cappedMinor || 0,
      exposure: money.toMajor(c.exposure?.cappedMinor || 0),
      reserveMinor: c.reserve?.currentMinor || 0,
      daysToTimeBar: limitation.daysRemaining(c),
    })),
  };
}

/**
 * Refresh the cached `claim.legal` roll-up.
 *
 * Mirrors the existing `claim.fraud` pattern: claim lists need a legal badge and
 * a "what expires first" sort without joining the exposures on every row.
 */
async function recomputeClaimRollup(claimId) {
  try {
    const claimants = await ThirdPartyClaim.find({ claim: claimId }).lean();
    if (!claimants.length) return null;

    const open = claimants.filter((c) => !['closed', 'paid', 'time_barred'].includes(c.status));
    const accident = await accidentExposure(claimId);

    const timeBars = open
      .map((c) => c.limitation?.extendedTo || c.limitation?.expiresAt)
      .filter(Boolean)
      .map((d) => new Date(d).getTime());

    await Claim.updateOne(
      { _id: claimId },
      {
        $set: {
          'legal.referred': true,
          'legal.thirdPartyClaimCount': claimants.length,
          'legal.openThirdPartyClaimCount': open.length,
          'legal.litigatedCount': claimants.filter((c) => c.legalCase).length,
          'legal.totalReserveMinor': claimants.reduce((a, c) => a + (c.reserve?.currentMinor || 0), 0),
          'legal.totalExposureMinor': accident.totalExposureMinor,
          'legal.limitEroded': accident.limitEroded,
          'legal.excessOfLimitMinor': accident.excessOfLimitMinor,
          'legal.nearestTimeBar': timeBars.length ? new Date(Math.min(...timeBars)) : null,
          'legal.recomputedAt': new Date(),
        },
      }
    );
    return accident;
  } catch (err) {
    // A roll-up failure must never fail the operation that triggered it — the
    // cache can be rebuilt, the underlying record cannot.
    logger.error(`[tpc] claim roll-up failed for ${claimId}: ${err.message}`);
    return null;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function list({ company, status, claimType, claim, handler, timeBarWithinDays, riskLevel, search, page = 1, limit = 25 }) {
  const filter = {};
  if (company) filter.company = company;
  if (status) filter.status = Array.isArray(status) ? { $in: status } : status;
  if (claimType) filter.claimType = claimType;
  if (claim) filter.claim = claim;
  if (handler) filter.handler = handler;
  if (riskLevel) filter.riskLevel = riskLevel;

  if (timeBarWithinDays) {
    filter['limitation.expiresAt'] = {
      $lte: new Date(Date.now() + Number(timeBarWithinDays) * 86400000),
    };
    filter.status = filter.status || { $nin: ['settled', 'paid', 'closed', 'time_barred'] };
  }

  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { referenceNumber: rx },
      { 'party.name': rx },
      { 'party.idNumber': rx },
      { policyNumber: rx },
    ];
  }

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const [items, total] = await Promise.all([
    ThirdPartyClaim.find(filter)
      .sort({ 'limitation.expiresAt': 1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('claim', 'incidentDetails.date vehiclesInvolved.licensePlate status')
      .lean(),
    ThirdPartyClaim.countDocuments(filter),
  ]);

  return {
    items: items.map(present),
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  };
}

async function getById(id) {
  const tpc = await ThirdPartyClaim.findById(id)
    .populate('claim', 'incidentDetails vehiclesInvolved status customerId policyRef source')
    .populate('handler', 'fullName email')
    .lean();
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  const [ledger, position] = await Promise.all([
    legalLedger.entries({ thirdPartyClaim: id }, { limit: 100 }),
    legalLedger.position({ thirdPartyClaim: id }),
  ]);

  return { ...present(tpc), ledger, position };
}

async function update(id, changes, actor = null) {
  const tpc = await ThirdPartyClaim.findById(id);
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  // These have their own permissioned endpoints and must not be settable through
  // a general update, which would route around ASSESS_* and the ledger.
  const PROTECTED = ['liability', 'quantum', 'reserve', 'exposure', 'company', 'claim', 'referenceNumber', 'limitation'];
  for (const key of PROTECTED) delete changes[key];

  Object.assign(tpc, changes);
  await tpc.save();
  await recomputeClaimRollup(tpc.claim);
  return tpc;
}

/** Add major-unit and formatted mirrors for the API. */
function present(tpc) {
  if (!tpc) return tpc;
  return {
    ...tpc,
    daysToTimeBar: limitation.daysRemaining(tpc),
    exposure: exposureService.presentExposure(tpc.exposure),
    reserve: tpc.reserve
      ? { ...tpc.reserve, current: money.toMajor(tpc.reserve.currentMinor || 0) }
      : tpc.reserve,
  };
}

module.exports = {
  register,
  assessLiability,
  assessQuantum,
  setReserve,
  seedReserve,
  recomputeExposure,
  recomputeClaimRollup,
  accidentExposure,
  resolveLimits,
  list,
  getById,
  update,
  present,
};
