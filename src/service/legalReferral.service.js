const LegalReferral = require('../models/legalReferral.model');
const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const legalConfig = require('./legalConfig.service');
const notify = require('./legalNotify.service');

/**
 * Referral — how an existing claim reaches Legal.
 *
 * Two ways in, and they produce the same kind of record so they share one queue:
 *   - a claims officer raises one by hand
 *   - a configured trigger fires on the claim
 *
 * Legal then accepts or returns it. Accepting is what actually marks the claim
 * as a legal matter; raising a referral does not, which is the point — otherwise
 * the legal register fills with things that are not legal matters.
 */

// ── Raising ──────────────────────────────────────────────────────────────────

/**
 * Raise a referral by hand.
 */
async function raise(data, actor = null) {
  const claim = await Claim.findById(data.claim).lean();
  if (!claim) throw new ApiError(404, 'Claim not found');
  if (!claim.company) throw new ApiError(400, 'That claim has no insurer');

  const existing = await LegalReferral.findOne({ claim: claim._id, status: 'pending' }).lean();
  if (existing) {
    throw new ApiError(
      409,
      `${existing.reference} is already pending on this claim. Add to that referral rather than raising a second.`
    );
  }
  if (!data.legalIssue?.trim()) {
    throw new ApiError(400, 'A referral must state the legal issue');
  }

  const reference = await Counter.nextReference({ prefix: 'REF', company: claim.company });

  const referral = await LegalReferral.create({
    reference,
    company: claim.company,
    claim: claim._id,
    reason: data.reason || 'other',
    legalIssue: data.legalIssue,
    urgency: data.urgency || 'normal',
    recommendedAction: data.recommendedAction,
    externalCounselRequired: Boolean(data.externalCounselRequired),
    notes: data.notes,
    snapshot: await snapshotClaim(claim),
    source: data.source || 'manual',
    trigger: data.trigger,
    triggerDetail: data.triggerDetail,
    riskScore: data.riskScore,
    riskLevel: data.riskLevel,
    raisedBy: actor?._id || actor?.id || null,
    raisedByName: actor?.fullName || actor?.name || (data.source === 'manual' ? 'Unknown' : 'System'),
  });

  await notifyRaised(referral, claim);

  logger.info(
    `[legal-referral] ${reference} raised on claim ${claim._id} (${referral.reason}, ${referral.urgency}) ` +
    `via ${referral.source}`
  );
  return referral;
}

/**
 * Copy the claim's position onto the referral.
 *
 * Snapshotted rather than looked up later so the referral shows what the officer
 * was actually looking at when they raised it — a claim that has moved on since
 * would otherwise make the referral read as though it were raised about
 * something else.
 */
async function snapshotClaim(claim) {
  try {
    const customer = claim.customerId
      ? await Customer.findById(claim.customerId).select('firstName lastName policyNumber').lean()
      : null;

    const docs = claim.supportingDocuments || {};
    return {
      policyNumber: claim.policyRef?.policyNumber || customer?.policyNumber,
      insuredName: customer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() : undefined,
      claimantName: claim.claimant?.name,
      vehicleRegistration: (claim.vehiclesInvolved || [])[0]?.licensePlate,
      accidentDate: claim.incidentDetails?.date,
      accidentLocation: claim.incidentDetails?.location,
      claimStatus: claim.status,
      reserveMinor: claim.legal?.totalReserveMinor,
      hasAssessmentReport: Boolean(claim.assessmentReport),
      hasInvestigationReport: Boolean(claim.fraud?.investigationId),
      hasPoliceReport: Boolean(claim.policeReport?.reportNumber),
      photoCount: (docs.photos || []).length,
      fraudSuspected: Boolean(claim.fraud?.suspected),
      fraudRiskLevel: claim.fraud?.riskLevel,
      capturedAt: new Date(),
    };
  } catch (err) {
    logger.warn(`[legal-referral] snapshot failed for claim ${claim._id}: ${err.message}`);
    return undefined;
  }
}

// ── Deciding ─────────────────────────────────────────────────────────────────

/**
 * Accept a referral into Legal. This is what marks the claim as a legal matter.
 */
async function accept(referralId, { notes } = {}, actor = null) {
  const referral = await LegalReferral.findById(referralId);
  if (!referral) throw new ApiError(404, 'Referral not found');
  if (referral.status !== 'pending') {
    throw new ApiError(409, `That referral is already ${referral.status}`);
  }

  referral.status = 'accepted';
  referral.decidedBy = actor?._id || actor?.id || null;
  referral.decidedByName = actor?.fullName || actor?.name;
  referral.decidedAt = new Date();
  referral.decisionNotes = notes;
  await referral.save();

  // The claim is now formally with Legal. Counts and exposure are maintained by
  // the third-party roll-up; this only records that Legal has taken it on.
  await Claim.updateOne(
    { _id: referral.claim },
    { $set: { 'legal.referred': true, 'legal.lastCheckedAt': new Date() } }
  );

  await notifyDecided(referral, 'accepted');
  logger.info(`[legal-referral] ${referral.reference} accepted by ${referral.decidedByName}`);
  return referral;
}

/**
 * Return a referral to the claims team. Requires a reason — a referral bounced
 * without explanation teaches people to stop raising them.
 */
async function returnToClaims(referralId, { notes }, actor = null) {
  if (!String(notes || '').trim()) {
    throw new ApiError(400, 'Returning a referral requires a reason the claims team can act on');
  }

  const referral = await LegalReferral.findById(referralId);
  if (!referral) throw new ApiError(404, 'Referral not found');
  if (referral.status !== 'pending') {
    throw new ApiError(409, `That referral is already ${referral.status}`);
  }

  referral.status = 'returned';
  referral.decidedBy = actor?._id || actor?.id || null;
  referral.decidedByName = actor?.fullName || actor?.name;
  referral.decidedAt = new Date();
  referral.decisionNotes = notes;
  await referral.save();

  await notifyDecided(referral, 'returned');
  return referral;
}

async function withdraw(referralId, actor = null) {
  const referral = await LegalReferral.findById(referralId);
  if (!referral) throw new ApiError(404, 'Referral not found');
  if (referral.status !== 'pending') {
    throw new ApiError(409, `That referral is already ${referral.status}`);
  }
  referral.status = 'withdrawn';
  referral.decidedAt = new Date();
  referral.decidedBy = actor?._id || actor?.id || null;
  await referral.save();
  return referral;
}

// ── Automatic triggers ───────────────────────────────────────────────────────

/**
 * The trigger catalogue.
 *
 * Each returns a reason string when it fires, or null. They read only what the
 * claim and its third-party exposures already hold — a trigger that needs a
 * lookup nobody has done is a trigger that will not fire in practice.
 *
 * `params` comes from the tenant's configuration, so thresholds are theirs.
 */
const TRIGGERS = {
  fatal_accident: ({ exposures }) =>
    exposures.some((e) => e.claimType === 'fatal' || e.injury?.deceased)
      ? 'A fatality has been recorded on this accident'
      : null,

  serious_bodily_injury: ({ exposures }) =>
    exposures.some((e) => ['serious', 'severe'].includes(e.injury?.severity))
      ? 'Serious injury recorded'
      : null,

  multiple_claimants: ({ exposures }) =>
    exposures.length >= 2 ? `${exposures.length} third parties are claiming on this accident` : null,

  claimant_represented: ({ exposures }) =>
    exposures.some((e) => e.opposingAdvocate?.name || e.opposingAdvocate?.firm)
      ? 'A claimant is represented by an advocate'
      : null,

  liability_disputed: ({ exposures }) =>
    exposures.some((e) => e.liability?.disputed) ? 'Liability is disputed' : null,

  third_party_demand: ({ exposures }) =>
    exposures.some((e) => e.demandReceivedAt) ? 'A third-party demand has been received' : null,

  claim_above_threshold: ({ exposures, params }) => {
    const thresholdMinor = Number.isInteger(params?.thresholdMinor)
      ? params.thresholdMinor
      : money.toMinor(params?.threshold ?? 1000000);
    const total = exposures.reduce((a, e) => a + (e.exposure?.cappedMinor || 0), 0);
    return total >= thresholdMinor
      ? `Exposure of ${money.formatMinor(total)} is at or above the referral threshold`
      : null;
  },

  fraud_investigation: ({ claim }) =>
    claim.fraud?.suspected || claim.fraud?.investigationId
      ? 'A fraud investigation has been opened on this claim'
      : null,

  coverage_disputed: ({ exposures }) =>
    exposures.some((e) => e.exposure?.limitApplied)
      ? 'Exposure exceeds the policy limit — the insured carries the excess'
      : null,

  claimant_rejected_offer: ({ exposures }) =>
    exposures.some((e) => e.status === 'declined_by_claimant' || e.status === 'negotiation')
      ? 'A claimant has rejected an offer'
      : null,

  summons_received: ({ exposures }) =>
    exposures.some((e) => e.source === 'summons') ? 'A summons has been received' : null,
};

/**
 * Evaluate one claim against the tenant's configured triggers.
 *
 * Returns what fired without acting, so the caller decides. A claim already
 * referred is skipped — re-referring something Legal is already handling is the
 * fastest way to make people ignore the queue.
 *
 * @returns {Promise<{ fired: Array, referral: Object|null }>}
 */
async function evaluate(claimId, { autoRaise = true } = {}) {
  const claim = await Claim.findById(claimId).lean();
  if (!claim?.company) return { fired: [], referral: null };

  const pending = await LegalReferral.findOne({
    claim: claim._id,
    status: { $in: ['pending', 'accepted'] },
  }).lean();
  if (pending) return { fired: [], referral: null, skipped: 'already referred' };

  const config = await legalConfig.get(claim.company);
  const configured = (config.referralTriggers || []).filter((t) => t.enabled !== false);
  if (!configured.length) return { fired: [], referral: null, skipped: 'no triggers configured' };

  const exposures = await ThirdPartyClaim.find({ claim: claim._id, deletedAt: null }).lean();

  const fired = [];
  for (const t of configured) {
    const fn = TRIGGERS[t.code];
    if (!fn) {
      logger.warn(`[legal-referral] company ${claim.company} configures unknown trigger '${t.code}'`);
      continue;
    }
    try {
      const detail = fn({ claim, exposures, params: t.params });
      if (detail) fired.push({ code: t.code, label: t.label || t.code, detail, autoRefer: t.autoRefer });
    } catch (err) {
      logger.error(`[legal-referral] trigger ${t.code} threw on claim ${claim._id}: ${err.message}`);
    }
  }

  if (!fired.length) return { fired: [], referral: null };

  // Only triggers the tenant marked autoRefer actually create a referral; the
  // rest are advisory and surface as flags. That distinction is the difference
  // between a useful queue and a flooded one.
  const referring = fired.filter((f) => f.autoRefer);
  if (!autoRaise || !referring.length) return { fired, referral: null };

  const primary = referring[0];
  const referral = await raise(
    {
      claim: claim._id,
      reason: primary.code,
      legalIssue: referring.map((f) => f.detail).join('; '),
      urgency: referring.some((f) => ['fatal_accident', 'summons_received'].includes(f.code)) ? 'high' : 'normal',
      source: 'automatic',
      trigger: primary.code,
      triggerDetail: primary.detail,
    },
    null
  );

  return { fired, referral };
}

/**
 * Sweep a tenant's open claims for triggers. Run nightly.
 */
async function sweep({ company, limit = 500 }) {
  const claims = await Claim.find({
    company,
    deletedAt: null,
    status: { $nin: ['Completed', 'Rejected'] },
    'legal.referred': { $ne: true },
  })
    .select('_id')
    .limit(limit)
    .lean();

  let evaluated = 0;
  let referred = 0;
  const flagged = [];

  for (const c of claims) {
    try {
      const result = await evaluate(c._id);
      evaluated += 1;
      if (result.referral) referred += 1;
      else if (result.fired.length) flagged.push({ claim: c._id, fired: result.fired.map((f) => f.code) });
    } catch (err) {
      logger.error(`[legal-referral] sweep failed on claim ${c._id}: ${err.message}`);
    }
  }

  if (referred) logger.info(`[legal-referral] sweep referred ${referred} of ${evaluated} claims`);
  return { evaluated, referred, flaggedOnly: flagged.length };
}

// ── Notification ─────────────────────────────────────────────────────────────

async function notifyRaised(referral, claim) {
  const t = referral.source === 'manual'
    ? notify.templates.referralRaised({
        reference: referral.reference,
        claimRef: referral.snapshot?.vehicleRegistration || String(referral.claim),
        reason: referral.legalIssue,
        urgency: referral.urgency,
        raisedBy: referral.raisedByName,
      })
    : notify.templates.autoReferred({
        reference: referral.reference,
        claimRef: referral.snapshot?.vehicleRegistration || String(referral.claim),
        trigger: referral.triggerDetail || referral.trigger,
      });

  await notify
    .sendToRoles({
      company: referral.company,
      roles: ['Legal Officer', 'Senior Legal Officer'],
      type: 'legal_referral_raised',
      title: t.title,
      body: t.body,
      claimId: referral.claim,
    })
    .catch((err) => logger.warn(`[legal-referral] notify raised failed: ${err.message}`));
}

async function notifyDecided(referral, decision) {
  if (!referral.raisedBy) return;
  const t = notify.templates.referralDecided({
    reference: referral.reference,
    decision,
    by: referral.decidedByName,
    notes: referral.decisionNotes,
  });

  await notify
    .sendToUser({
      userId: referral.raisedBy,
      type: 'legal_referral_decided',
      title: t.title,
      body: t.body,
      claimId: referral.claim,
    })
    .catch((err) => logger.warn(`[legal-referral] notify decided failed: ${err.message}`));
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function list({ company, status, urgency, source, page = 1, limit = 25 }) {
  const filter = {};
  if (company) filter.company = company;
  if (status) filter.status = status;
  if (urgency) filter.urgency = urgency;
  if (source) filter.source = source;

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    LegalReferral.find(filter)
      .sort({ urgency: -1, raisedAt: 1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('claim', 'incidentDetails vehiclesInvolved status')
      .lean(),
    LegalReferral.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) };
}

async function getById(id) {
  const referral = await LegalReferral.findById(id)
    .populate('claim', 'incidentDetails vehiclesInvolved status customerId legal')
    .populate('raisedBy', 'fullName email')
    .lean();
  if (!referral) throw new ApiError(404, 'Referral not found');
  return referral;
}

module.exports = {
  raise,
  accept,
  returnToClaims,
  withdraw,
  evaluate,
  sweep,
  list,
  getById,
  TRIGGERS,
};
