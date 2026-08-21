const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const thirdPartyClaimService = require('./thirdPartyClaim.service');

/**
 * The gateway into the Legal module.
 *
 * There are TWO entry paths, and the second is the one that makes this module
 * different from the rest of AVICS:
 *
 *   1. A third party emerges on an accident the insured already reported.
 *      Ordinary: the Claim exists, we hang an exposure off it.
 *
 *   2. A demand arrives naming only a VEHICLE REGISTRATION and a date, for an
 *      accident the insured never reported at all. Common — an insured who
 *      scratched someone's car and drove on has no reason to call their insurer,
 *      and the first anyone hears is a letter from the other side's advocate.
 *      There is no Claim to attach to, so the Legal Officer opens one.
 *
 * Path 2 is why Claim gained `source: 'third_party_notification'` and why the
 * insured-side required fields became conditional: the record has to be able to
 * exist with nothing but a registration, a date and a claimant.
 */

const normaliseReg = (reg) => String(reg || '').toUpperCase().replace(/[\s-]/g, '');

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Given a registration and an accident date, find what we already know.
 *
 * Returns both candidate accidents already on file and the policy in force, so
 * the Legal Officer can see before creating anything whether this is a new
 * accident or one already being handled. Creating a duplicate accident record is
 * the main risk on this path — it splits one event's exposure across two files.
 *
 * @param {Object} params
 * @param {*}      params.company
 * @param {string} params.registration
 * @param {Date}   params.accidentDate
 * @param {number} [params.windowDays=7]  tolerance on the date the claimant gives
 */
async function matchDemand({ company, registration, accidentDate, windowDays = 7 }) {
  if (!registration) throw new ApiError(400, 'A vehicle registration is required to match a demand');

  const reg = normaliseReg(registration);
  const date = accidentDate ? new Date(accidentDate) : null;

  // ── Candidate accidents ──────────────────────────────────────────────────
  // The claimant's recollection of the date is often approximate, so search a
  // window rather than an exact day.
  const claimFilter = { company };
  if (date) {
    claimFilter['incidentDetails.date'] = {
      $gte: new Date(date.getTime() - windowDays * 86400000),
      $lte: new Date(date.getTime() + windowDays * 86400000),
    };
  }

  const candidates = await Claim.find(claimFilter)
    .select('incidentDetails vehiclesInvolved status source legal customerId createdAt')
    .limit(50)
    .lean();

  // Registration match is done in memory: normalising both sides (case, spaces,
  // hyphens) is not something the index can do, and the date window has already
  // cut this to a handful of rows.
  const matches = candidates.filter((c) =>
    (c.vehiclesInvolved || []).some((v) => normaliseReg(v.licensePlate) === reg)
  );

  // ── Policy in force ──────────────────────────────────────────────────────
  const policyMatch = await findPolicyByRegistration({ company, registration: reg, on: date });

  return {
    registration: reg,
    accidentDate: date,
    windowDays,
    candidateClaims: matches.map((c) => ({
      _id: c._id,
      accidentDate: c.incidentDetails?.date,
      location: c.incidentDetails?.location,
      status: c.status,
      source: c.source,
      registrations: (c.vehiclesInvolved || []).map((v) => v.licensePlate),
      existingThirdPartyClaims: c.legal?.thirdPartyClaimCount || 0,
    })),
    policy: policyMatch,
    // What the UI should do next.
    recommendation: matches.length
      ? 'attach_to_existing'
      : policyMatch?.policy
        ? 'create_third_party_notification'
        : 'no_cover_found',
  };
}

/**
 * Find which policy covered a registration on a given date.
 *
 * This is the lookup that made the new
 * `{ company, 'policies.vehicle.registration' }` index necessary — a claimant
 * names a vehicle, never a policy number.
 */
async function findPolicyByRegistration({ company, registration, on = null }) {
  const reg = normaliseReg(registration);

  const customers = await Customer.find({
    company,
    'policies.vehicle.registration': { $exists: true },
  })
    .select('firstName lastName phone email policyNumber policies company')
    .limit(200)
    .lean();

  for (const customer of customers) {
    for (const policy of customer.policies || []) {
      if (normaliseReg(policy.vehicle?.registration) !== reg) continue;

      // Was it in force on the accident date? A lapsed policy is a coverage
      // issue the Legal team must see immediately, not a reason to hide the hit.
      const inForce =
        !on ||
        ((!policy.startDate || new Date(policy.startDate) <= on) &&
          (!policy.expiryDate || new Date(policy.expiryDate) >= on));

      return {
        customer: {
          _id: customer._id,
          name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
          phone: customer.phone,
          email: customer.email,
        },
        policy,
        inForceOnAccidentDate: inForce,
        coverageConcern: inForce ? null : `Policy status '${policy.status}' — not in force on the accident date`,
        hasLimits: Boolean(
          policy.liabilityLimits?.propertyDamageMinor ||
          policy.liabilityLimits?.bodilyInjuryMinor ||
          policy.liabilityLimits?.aggregateMinor
        ),
      };
    }
  }

  return null;
}

// ── Cold demand ──────────────────────────────────────────────────────────────

/**
 * Record a demand for an accident the insured never reported.
 *
 * Opens the accident record AND the third-party exposure in one step, because
 * neither is useful without the other. The Claim is stamped
 * `source: 'third_party_notification'` so it stays out of assessment and bidding
 * until the insured's side arrives.
 *
 * @param {Object} data
 * @param {*}      data.company
 * @param {string} data.registration
 * @param {Date}   data.accidentDate
 * @param {Object} data.party           the claimant
 * @param {string} data.claimType
 * @param {Object} [actor]
 */
async function recordDemand(data, actor = null) {
  const { company, registration, accidentDate, party, claimType } = data;

  if (!registration) throw new ApiError(400, 'A vehicle registration is required');
  if (!accidentDate) throw new ApiError(400, 'An accident date is required — the limitation clock runs from it');
  if (!party?.name) throw new ApiError(400, 'The claimant\'s name is required');

  // If the caller nominated an existing accident, use it rather than opening a
  // second record for the same event.
  if (data.claim) {
    const tpc = await thirdPartyClaimService.register(
      { ...data, claim: data.claim, source: data.source || 'third_party_demand' },
      actor
    );
    return { claim: await Claim.findById(data.claim).lean(), thirdPartyClaim: tpc, createdClaim: false };
  }

  const policyMatch = await findPolicyByRegistration({
    company,
    registration,
    on: new Date(accidentDate),
  });

  if (!policyMatch) {
    throw new ApiError(
      404,
      `No policy on file covers registration ${normaliseReg(registration)}. ` +
      'Check the registration, or confirm the vehicle is insured elsewhere before opening a file.'
    );
  }

  const claim = await Claim.create({
    company,
    customerId: policyMatch.customer._id,
    source: 'third_party_notification',
    // Everything we actually know. The insured-side fields stay empty by design;
    // the conditional validators on the model permit that for this source only.
    incidentDetails: {
      date: new Date(accidentDate),
      location: data.accidentLocation,
      description: data.accidentDescription || `Reported by third party ${party.name}`,
    },
    vehiclesInvolved: data.insuredVehicle
      ? [data.insuredVehicle]
      : [{ licensePlate: policyMatch.policy.vehicle?.registration || registration }],
    policyRef: {
      policyNumber: policyMatch.policy.policyNumber,
      resolvedAt: new Date(),
      resolvedBy: actor?._id || actor?.id || null,
    },
    description: data.accidentDescription,
    // Held out of the repair flow: there is no insured-side damage to assess.
    status: 'Pending',
  });

  logger.info(
    `[legal-intake] opened claim ${claim._id} from a third-party notification ` +
    `(${normaliseReg(registration)}, policy ${policyMatch.policy.policyNumber})` +
    (policyMatch.inForceOnAccidentDate ? '' : ' — POLICY NOT IN FORCE ON THE ACCIDENT DATE')
  );

  const thirdPartyClaim = await thirdPartyClaimService.register(
    {
      claim: claim._id,
      claimType,
      party,
      injury: data.injury,
      propertyDamage: data.propertyDamage,
      opposingAdvocate: data.opposingAdvocate,
      quantum: data.quantum,
      policyNumber: policyMatch.policy.policyNumber,
      source: data.opposingAdvocate?.name ? 'advocate_demand' : 'third_party_demand',
      demandReceivedAt: data.demandReceivedAt || new Date(),
      demandDocuments: data.demandDocuments,
      firstNotifiedAt: new Date(),
      status: 'demand_received',
    },
    actor
  );

  return {
    claim: claim.toObject(),
    thirdPartyClaim,
    createdClaim: true,
    coverageConcern: policyMatch.coverageConcern,
    policyHasLimits: policyMatch.hasLimits,
  };
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge a third-party notification into the insured's own later report of the
 * same accident.
 *
 * The insured's record survives — it carries the assessment, photos and repair
 * history, and its claim number may already be in use elsewhere. The
 * notification record's third-party exposures move across, and it is marked
 * merged rather than deleted so the audit trail of what was known when survives.
 *
 * @param {*} sourceClaimId   the third-party notification record
 * @param {*} targetClaimId   the insured's report
 */
async function mergeClaims(sourceClaimId, targetClaimId, actor = null) {
  if (String(sourceClaimId) === String(targetClaimId)) {
    throw new ApiError(400, 'Cannot merge a claim into itself');
  }

  const [source, target] = await Promise.all([
    Claim.findById(sourceClaimId),
    Claim.findById(targetClaimId),
  ]);
  if (!source) throw new ApiError(404, 'Source claim not found');
  if (!target) throw new ApiError(404, 'Target claim not found');

  if (String(source.company) !== String(target.company)) {
    throw new ApiError(400, 'Cannot merge claims belonging to different insurers');
  }
  if (source.mergedInto) {
    throw new ApiError(409, 'That claim has already been merged');
  }

  const moved = await ThirdPartyClaim.updateMany(
    { claim: source._id },
    { $set: { claim: target._id } }
  );

  source.mergedInto = target._id;
  source.mergedAt = new Date();
  await source.save();

  target.mergedFrom = [...(target.mergedFrom || []), source._id];
  target.mergedAt = new Date();
  // Carry across the policy reference if the insured's report lacks one.
  if (!target.policyRef?.policyNumber && source.policyRef?.policyNumber) {
    target.policyRef = source.policyRef;
  }
  await target.save();

  await thirdPartyClaimService.recomputeClaimRollup(target._id);

  logger.info(
    `[legal-intake] merged claim ${source._id} into ${target._id} — ` +
    `${moved.modifiedCount} third-party exposure(s) moved`
  );

  return {
    source: source._id,
    target: target._id,
    thirdPartyClaimsMoved: moved.modifiedCount,
  };
}

module.exports = {
  matchDemand,
  findPolicyByRegistration,
  recordDemand,
  mergeClaims,
  normaliseReg,
};
