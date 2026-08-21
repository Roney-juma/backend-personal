const Settlement = require('../models/settlement.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const approvals = require('./approval.service');
const legalLedger = require('./legalLedger.service');
const legalConfig = require('./legalConfig.service');
const thirdPartyClaimService = require('./thirdPartyClaim.service');

/**
 * Settlement of a third-party claim: negotiate, authorise, execute, pay.
 *
 * The lifecycle deliberately separates three things people tend to conflate:
 *   approved  — WE are authorised to offer this
 *   accepted  — the CLAIMANT has taken it
 *   paid      — the money has actually gone
 *
 * Most of a live negotiation sits between the first two, and a system that
 * cannot express "authorised but not yet agreed" forces staff to track it
 * somewhere else.
 */

const LIVE_STATUSES = ['draft', 'pending_approval', 'approved', 'accepted', 'executed'];

/**
 * Open a settlement on an exposure, with our opening offer.
 */
async function propose(data, actor = null) {
  const tpc = await ThirdPartyClaim.findById(data.thirdPartyClaim);
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  if (['closed', 'time_barred', 'paid'].includes(tpc.status)) {
    throw new ApiError(409, `Cannot settle a claim that is ${tpc.status.replace(/_/g, ' ')}`);
  }

  const existing = await Settlement.findOne({
    thirdPartyClaim: tpc._id,
    status: { $in: LIVE_STATUSES },
  }).lean();
  if (existing) {
    throw new ApiError(
      409,
      `${existing.reference} is already live on this claim (${existing.status.replace(/_/g, ' ')}). ` +
      'Revise or withdraw it rather than opening a second.'
    );
  }

  const proposedMinor = toMinorAmount(data, 'proposed');
  const claimantCostsMinor = toMinorAmount(data, 'claimantCosts', 0);
  const interestMinor = toMinorAmount(data, 'interest', 0);
  const totalMinor = money.sumMinor([proposedMinor, claimantCostsMinor, interestMinor]);

  const reference = await Counter.nextReference({ prefix: 'SET', company: tpc.company });

  const settlement = await Settlement.create({
    reference,
    company: tpc.company,
    claim: tpc.claim,
    thirdPartyClaim: tpc._id,
    legalCase: tpc.legalCase,

    offers: [
      {
        by: 'insurer',
        amountMinor: proposedMinor,
        madeBy: actor?._id || actor?.id || null,
        madeByName: actor?.fullName || actor?.name || 'System',
        notes: data.rationale,
        channel: data.channel || 'letter',
        at: new Date(),
      },
    ],

    proposedMinor,
    claimantCostsMinor,
    interestMinor,
    totalMinor,

    // Snapshot the position the proposer was looking at, so an approver does not
    // have to reconstruct it — and so the record still makes sense if the
    // exposure is later revised.
    exposureAtProposalMinor: tpc.exposure?.cappedMinor ?? 0,
    reserveAtProposalMinor: tpc.reserve?.currentMinor ?? 0,
    demandedMinor: tpc.quantum?.demandedMinor,

    proposedBy: actor?._id || actor?.id || null,
    proposedByName: actor?.fullName || actor?.name || 'System',
    rationale: data.rationale,
    payee: data.payee,
    status: 'draft',
  });

  if (tpc.status === 'notified' || tpc.status === 'demand_received' || tpc.status === 'under_assessment') {
    tpc.status = 'negotiation';
    await tpc.save();
  }

  logger.info(
    `[settlement] ${reference} opened on ${tpc.referenceNumber} at ${money.formatMinor(totalMinor)} ` +
    `(reserve ${money.formatMinor(tpc.reserve?.currentMinor || 0)})`
  );
  return settlement;
}

/**
 * Record a move in the negotiation.
 *
 * A claimant's counter changes nothing about our authority. Our own revised
 * offer becomes the figure the matrix is applied to — and if it now exceeds
 * what was already approved, the approval is invalidated rather than silently
 * carried, because authority given for one figure is not authority for a larger.
 */
async function addOffer(settlementId, offer, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (!LIVE_STATUSES.includes(settlement.status)) {
    throw new ApiError(409, `That settlement is ${settlement.status.replace(/_/g, ' ')} and can no longer be negotiated`);
  }

  const amountMinor = Number.isInteger(offer.amountMinor)
    ? offer.amountMinor
    : money.toMinor(offer.amount);
  if (amountMinor < 0) throw new ApiError(400, 'An offer cannot be negative');

  const by = offer.by === 'claimant' ? 'claimant' : 'insurer';

  settlement.offers.push({
    by,
    amountMinor,
    madeBy: by === 'insurer' ? actor?._id || actor?.id || null : undefined,
    madeByName: by === 'insurer' ? actor?.fullName || actor?.name : offer.madeByName,
    notes: offer.notes,
    channel: offer.channel,
    withoutPrejudice: offer.withoutPrejudice !== false,
    at: offer.at ? new Date(offer.at) : new Date(),
  });

  if (by === 'insurer') {
    settlement.proposedMinor = amountMinor;
    settlement.totalMinor = money.sumMinor([
      amountMinor,
      settlement.claimantCostsMinor || 0,
      settlement.interestMinor || 0,
    ]);

    // Authority does not stretch upward.
    if (
      settlement.status === 'approved' &&
      settlement.approvedAmountMinor !== undefined &&
      settlement.totalMinor > settlement.approvedAmountMinor
    ) {
      settlement.status = 'draft';
      settlement.approvedAt = undefined;
      settlement.approvedBy = undefined;
      settlement.approvedAmountMinor = undefined;
      logger.info(
        `[settlement] ${settlement.reference} revised above its approved figure — authority withdrawn, ` +
        're-approval required'
      );
    }
  }

  await settlement.save();
  return settlement;
}

/**
 * Send the settlement for authority, routed by the tenant's matrix.
 */
async function submitForApproval(settlementId, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (!['draft', 'rejected'].includes(settlement.status)) {
    throw new ApiError(409, `That settlement is already ${settlement.status.replace(/_/g, ' ')}`);
  }
  if (!settlement.totalMinor) {
    throw new ApiError(400, 'A settlement cannot be sent for approval at zero');
  }

  const tpc = await ThirdPartyClaim.findById(settlement.thirdPartyClaim).lean();

  const request = await approvals.createRequest(
    {
      company: settlement.company,
      subjectType: 'Settlement',
      subjectId: settlement._id,
      claim: settlement.claim,
      thirdPartyClaim: settlement.thirdPartyClaim,
      legalCase: settlement.legalCase,
      amountMinor: settlement.totalMinor,
      currency: settlement.currency,
      summary:
        `${settlement.reference} — ${tpc?.party?.name || 'third-party claim'} ` +
        `(${tpc?.referenceNumber || ''}): ${money.formatMinor(settlement.totalMinor)} ` +
        `against a reserve of ${money.formatMinor(settlement.reserveAtProposalMinor || 0)} ` +
        `and exposure of ${money.formatMinor(settlement.exposureAtProposalMinor || 0)}`,
      justification: settlement.rationale,
    },
    actor
  );

  settlement.approvalRequest = request._id;
  settlement.status = 'pending_approval';
  await settlement.save();

  return { settlement, approvalRequest: request };
}

/**
 * Apply an approval decision back onto the settlement.
 * Called after approval.service.decide() has recorded and authorised it.
 */
async function applyDecision(settlementId, decision, notes, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');

  if (decision === 'approved') {
    settlement.status = 'approved';
    settlement.approvedAt = new Date();
    settlement.approvedBy = actor?._id || actor?.id || null;
    // Pin the figure that was authorised — see addOffer().
    settlement.approvedAmountMinor = settlement.totalMinor;
  } else if (decision === 'rejected') {
    settlement.status = 'rejected';
    settlement.rejectedAt = new Date();
    settlement.rejectionReason = notes;
  }

  await settlement.save();
  logger.info(
    `[settlement] ${settlement.reference} ${decision} at ${money.formatMinor(settlement.totalMinor)}`
  );
  return settlement;
}

/**
 * The claimant has accepted (or declined).
 */
async function recordClaimantResponse(settlementId, { accepted, via, at }, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (settlement.status !== 'approved') {
    throw new ApiError(
      409,
      `Only an approved settlement can be accepted — this one is ${settlement.status.replace(/_/g, ' ')}`
    );
  }

  if (accepted) {
    settlement.status = 'accepted';
    settlement.acceptedAt = at ? new Date(at) : new Date();
    settlement.acceptedVia = via;
  } else {
    settlement.status = 'declined_by_claimant';
  }

  await settlement.save();
  return settlement;
}

/**
 * Execute: the agreement is concluded and the liability is now certain.
 *
 * This is where the money hits the ledger — as an accrual, not a payment. The
 * insurer owes it from this point; whether Finance has moved it yet is a
 * separate fact, tracked by markPaid().
 */
async function execute(settlementId, data = {}, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (settlement.status !== 'accepted') {
    throw new ApiError(
      409,
      `Only an accepted settlement can be executed — this one is ${settlement.status.replace(/_/g, ' ')}`
    );
  }

  if (data.dischargeVoucher) {
    settlement.dischargeVoucher = {
      ...settlement.dischargeVoucher,
      ...data.dischargeVoucher,
      receivedAt: data.dischargeVoucher.receivedAt || new Date(),
    };
  }
  if (data.consentJudgment !== undefined) settlement.consentJudgment = data.consentJudgment;

  const tpc = await ThirdPartyClaim.findById(settlement.thirdPartyClaim);

  // Damages and the claimant's costs post separately: they are conceded for
  // different reasons and reported separately.
  await legalLedger.post(
    {
      company: settlement.company,
      claim: settlement.claim,
      thirdPartyClaim: settlement.thirdPartyClaim,
      legalCase: settlement.legalCase,
      entryType: 'settlement',
      amountMinor: settlement.proposedMinor,
      counterparty: { type: 'claimant', name: tpc?.party?.name },
      sourceRef: { model: 'Settlement', id: settlement._id },
      status: 'accrued',
      description: `Settlement ${settlement.reference}`,
    },
    actor
  );

  if (settlement.claimantCostsMinor > 0) {
    await legalLedger.post(
      {
        company: settlement.company,
        claim: settlement.claim,
        thirdPartyClaim: settlement.thirdPartyClaim,
        legalCase: settlement.legalCase,
        entryType: 'claimant_costs',
        amountMinor: settlement.claimantCostsMinor,
        sourceRef: { model: 'Settlement', id: settlement._id },
        status: 'accrued',
        description: `Claimant costs on ${settlement.reference}`,
      },
      actor
    );
  }

  if (settlement.interestMinor > 0) {
    await legalLedger.post(
      {
        company: settlement.company,
        claim: settlement.claim,
        thirdPartyClaim: settlement.thirdPartyClaim,
        legalCase: settlement.legalCase,
        entryType: 'interest',
        amountMinor: settlement.interestMinor,
        sourceRef: { model: 'Settlement', id: settlement._id },
        status: 'accrued',
        description: `Interest on ${settlement.reference}`,
      },
      actor
    );
  }

  settlement.status = 'executed';
  settlement.executedAt = new Date();
  settlement.executedBy = actor?._id || actor?.id || null;
  await settlement.save();

  if (tpc) {
    tpc.status = 'settled';
    tpc.settledAt = new Date();
    tpc.settledAmountMinor = settlement.totalMinor;
    tpc.outcome = 'settled';
    await tpc.save();
    await thirdPartyClaimService.recomputeClaimRollup(tpc.claim);
  }

  logger.info(`[settlement] ${settlement.reference} executed — ${money.formatMinor(settlement.totalMinor)}`);
  return settlement;
}

/**
 * Hand the settlement to Finance for payment.
 */
async function requestPayment(settlementId, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (settlement.status !== 'executed') {
    throw new ApiError(409, 'Only an executed settlement can be sent for payment');
  }

  await assertPaymentPrerequisites(settlement);

  settlement.paymentRequestedAt = new Date();
  settlement.paymentRequestedBy = actor?._id || actor?.id || null;
  await settlement.save();
  return settlement;
}

/**
 * Money has gone. Flips the ledger accrual to paid.
 */
async function markPaid(settlementId, data, actor = null) {
  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (!['executed'].includes(settlement.status)) {
    throw new ApiError(
      409,
      `Only an executed settlement can be paid — this one is ${settlement.status.replace(/_/g, ' ')}`
    );
  }

  await assertPaymentPrerequisites(settlement);

  /**
   * Payment marks the existing accruals paid rather than posting new entries.
   *
   * The settlement, costs and interest already hit the ledger at execution —
   * that is when the insurer became liable. Posting them again here would
   * double-count the entire matter in every exposure figure and every report.
   * What changes at payment is discharge, not cost.
   */
  const marked = await legalLedger
    .markSourcePaid({ model: 'Settlement', id: settlement._id }, actor)
    .catch((err) => {
      // Loud: the settlement would otherwise read as paid while the ledger still
      // showed the money outstanding.
      logger.error(
        `[settlement] ledger update failed on payment of ${settlement.reference}: ${err.message}`
      );
      throw err;
    });

  if (marked === 0) {
    throw new ApiError(
      409,
      `No outstanding ledger entries found for ${settlement.reference} — it may already be paid`
    );
  }

  settlement.status = 'paid';
  settlement.paidAt = new Date();
  settlement.paidBy = actor?._id || actor?.id || null;
  settlement.paymentMethod = data.paymentMethod;
  settlement.paymentReference = data.paymentReference;
  if (data.payee) settlement.payee = { ...settlement.payee, ...data.payee };
  await settlement.save();

  const tpc = await ThirdPartyClaim.findById(settlement.thirdPartyClaim);
  if (tpc) {
    tpc.status = 'paid';
    await tpc.save();
    await thirdPartyClaimService.recomputeClaimRollup(tpc.claim);
  }

  logger.info(`[settlement] ${settlement.reference} PAID — ${money.formatMinor(settlement.totalMinor)}`);
  return settlement;
}

/**
 * Documents the tenant requires before money moves.
 *
 * Paying without a signed discharge leaves the claim technically open — the
 * claimant has the money and, on paper, still has the claim.
 */
async function assertPaymentPrerequisites(settlement) {
  const config = await legalConfig.get(settlement.company);
  const required = config.documentRequirements?.beforePayment || [];

  if (required.includes('discharge_voucher') && !settlement.dischargeVoucher?.receivedAt) {
    throw new ApiError(
      400,
      'A signed discharge voucher is required before this settlement can be paid. ' +
      'Record it on the settlement, or remove the requirement in legal configuration.'
    );
  }
}

async function withdraw(settlementId, reason, actor = null) {
  if (!String(reason || '').trim()) throw new ApiError(400, 'Withdrawing a settlement needs a reason');

  const settlement = await Settlement.findById(settlementId);
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (['paid', 'executed'].includes(settlement.status)) {
    throw new ApiError(409, 'An executed settlement cannot be withdrawn — reverse it in the ledger instead');
  }

  settlement.status = 'withdrawn';
  settlement.withdrawnAt = new Date();
  settlement.withdrawalReason = reason;
  await settlement.save();
  return settlement;
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function list({ company, status, thirdPartyClaim, page = 1, limit = 25 }) {
  const filter = {};
  if (company) filter.company = company;
  if (status) filter.status = Array.isArray(status) ? { $in: status } : status;
  if (thirdPartyClaim) filter.thirdPartyClaim = thirdPartyClaim;

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Settlement.find(filter)
      .sort({ proposedAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('thirdPartyClaim', 'referenceNumber party claimType exposure reserve')
      .lean(),
    Settlement.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) };
}

async function getById(id) {
  const settlement = await Settlement.findById(id)
    .populate('thirdPartyClaim', 'referenceNumber party claimType exposure reserve quantum limitation status')
    .populate('proposedBy', 'fullName')
    .populate('approvedBy', 'fullName')
    .lean();
  if (!settlement) throw new ApiError(404, 'Settlement not found');

  const approval = await approvals.findForSubject('Settlement', id);
  return { ...settlement, approval };
}

/** Accept either `xMinor` (exact) or `x` (major units) from the API. */
function toMinorAmount(data, key, fallback = undefined) {
  const minorKey = `${key}Minor`;
  if (Number.isInteger(data[minorKey])) return data[minorKey];
  if (data[key] !== undefined && data[key] !== null && data[key] !== '') return money.toMinor(data[key]);
  if (fallback !== undefined) return fallback;
  throw new ApiError(400, `${key} is required`);
}

module.exports = {
  propose,
  addOffer,
  submitForApproval,
  applyDecision,
  recordClaimantResponse,
  execute,
  requestPayment,
  markPaid,
  withdraw,
  list,
  getById,
};
