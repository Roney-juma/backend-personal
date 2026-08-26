const mongoose = require('mongoose');
const LegalLedgerEntry = require('../models/legalLedgerEntry.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const { LEDGER_ENTRY_TYPES } = require('../constants/legal.constants');
const { sumMinor } = require('../utils/money');

/**
 * The legal financial ledger.
 *
 * Every figure the Legal module reports — a reserve, a net exposure, an
 * advocate's savings, the monthly spend — is an aggregation over this one
 * append-only stream. Nothing else writes money.
 *
 * Two rules make it trustworthy:
 *   1. `direction` is DERIVED from the entry type, never accepted from a caller.
 *      A recovery cannot raise exposure; a court fee cannot lower it.
 *   2. Nothing is ever edited or deleted. A mistake is corrected by posting a
 *      reversing entry that points at the original.
 *
 * All amounts are integer minor units — see utils/money.js.
 */

// ── Posting ──────────────────────────────────────────────────────────────────

/**
 * Post an entry.
 *
 * @param {Object} data
 * @param {*}      data.company
 * @param {*}      data.claim
 * @param {*}      [data.thirdPartyClaim]
 * @param {*}      [data.legalCase]
 * @param {string} data.entryType     key of LEDGER_ENTRY_TYPES
 * @param {number} data.amountMinor   integer minor units
 * @param {string} [data.reserveBucket]
 * @param {Object} [data.counterparty]
 * @param {Object} [data.sourceRef]
 * @param {string} [data.status='accrued']
 * @param {string} [data.description]
 * @param {Date}   [data.occurredAt]
 * @param {Object} [actor]            req.user
 * @param {Object} [opts]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<Object>} the created entry
 */
async function post(data, actor = null, opts = {}) {
  const spec = LEDGER_ENTRY_TYPES[data.entryType];
  if (!spec) {
    throw new ApiError(400, `Unknown ledger entry type: ${data.entryType}`);
  }

  if (!Number.isInteger(data.amountMinor)) {
    throw new ApiError(400, 'amountMinor must be an integer number of minor units');
  }
  // Only reserve adjustments may be negative — everything else states its
  // direction through its type, so a negative amount would double-negate.
  if (!spec.signed && data.amountMinor < 0) {
    throw new ApiError(400, `${data.entryType} cannot be negative — post a reversal instead`);
  }
  if (data.amountMinor === 0) {
    throw new ApiError(400, 'A ledger entry cannot be for zero');
  }
  if (spec.reserve && !data.reserveBucket) {
    throw new ApiError(400, `${data.entryType} requires a reserveBucket`);
  }
  if (!data.company || !data.claim) {
    throw new ApiError(400, 'A ledger entry must carry both company and claim');
  }

  const [entry] = await LegalLedgerEntry.create(
    [
      {
        company: data.company,
        claim: data.claim,
        thirdPartyClaim: data.thirdPartyClaim || null,
        legalCase: data.legalCase || null,
        entryType: data.entryType,
        direction: spec.direction,          // derived, never from the caller
        amountMinor: data.amountMinor,
        currency: data.currency || 'KES',
        reserveBucket: spec.reserve ? data.reserveBucket : undefined,
        counterparty: data.counterparty,
        sourceRef: data.sourceRef,
        status: data.status || 'accrued',
        description: data.description,
        occurredAt: data.occurredAt || new Date(),
        postedAt: new Date(),
        postedBy: actor?._id || actor?.id || null,
        postedByName: actor?.fullName || actor?.name || 'System',
      },
    ],
    opts.session ? { session: opts.session } : {}
  );

  return entry;
}

/**
 * Reverse an existing entry.
 *
 * Posts a mirror-image entry rather than touching the original, so the history
 * shows both that the mistake happened and that it was corrected — which is the
 * behaviour an auditor expects to find.
 *
 * @param {*} entryId
 * @param {string} reason
 * @param {Object} actor
 * @param {Object} [opts]
 * @returns {Promise<Object>} the reversing entry
 */
async function reverse(entryId, reason, actor = null, opts = {}) {
  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, 'A reversal requires a reason');
  }

  const original = await LegalLedgerEntry.findById(entryId).lean();
  if (!original) throw new ApiError(404, 'Ledger entry not found');
  if (original.status === 'reversed') {
    throw new ApiError(409, 'That entry has already been reversed');
  }

  const existing = await LegalLedgerEntry.findOne({ reversalOf: original._id }).lean();
  if (existing) {
    throw new ApiError(409, 'A reversal for that entry already exists');
  }

  const [reversal] = await LegalLedgerEntry.create(
    [
      {
        company: original.company,
        claim: original.claim,
        thirdPartyClaim: original.thirdPartyClaim,
        legalCase: original.legalCase,
        entryType: original.entryType,
        // Flip the sign of the effect by flipping the direction, keeping the
        // entry type intact so reporting by type still balances to zero.
        direction: original.direction === 'debit' ? 'credit' : 'debit',
        amountMinor: original.amountMinor,
        currency: original.currency,
        reserveBucket: original.reserveBucket,
        counterparty: original.counterparty,
        sourceRef: original.sourceRef,
        status: 'reversed',
        description: `Reversal of ${original._id}: ${reason}`,
        occurredAt: new Date(),
        postedAt: new Date(),
        postedBy: actor?._id || actor?.id || null,
        postedByName: actor?.fullName || actor?.name || 'System',
        reversalOf: original._id,
        reversalReason: reason,
      },
    ],
    opts.session ? { session: opts.session } : {}
  );

  logger.info(`[legal-ledger] reversed ${original._id} (${original.entryType}) — ${reason}`);
  return reversal;
}

/**
 * Mark every entry raised by one source document as paid.
 *
 * Payment does NOT change exposure. A settled claim cost what it cost whether or
 * not Finance has moved the money yet — "how much did this matter cost us" and
 * "how much of it has been discharged" are different questions on different
 * axes. Posting a second entry at payment time would double-count the whole
 * matter, so payment flips the existing accruals instead.
 *
 * This is the one permitted in-place write on the ledger, and it is deliberately
 * narrow: `status` is lifecycle bookkeeping, exactly like `sealId` on an audit
 * row. Amount, direction, date and source are never touched, so nothing that
 * feeds a financial figure can change. Hence the explicit `allowMutation` —
 * every other update path stays blocked by the append-only plugin.
 *
 * @param {Object} sourceRef  { model, id }
 * @param {Object} [actor]
 * @returns {Promise<number>} entries marked
 */
async function markSourcePaid(sourceRef, actor = null) {
  if (!sourceRef?.model || !sourceRef?.id) {
    throw new ApiError(400, 'markSourcePaid needs a source model and id');
  }

  const result = await LegalLedgerEntry.updateMany(
    {
      'sourceRef.model': sourceRef.model,
      'sourceRef.id': toObjectId(sourceRef.id),
      status: { $in: ['accrued', 'approved'] },
    },
    { $set: { status: 'paid' } },
    { allowMutation: true }
  );

  logger.info(
    `[legal-ledger] ${result.modifiedCount} entr${result.modifiedCount === 1 ? 'y' : 'ies'} from ` +
    `${sourceRef.model} ${sourceRef.id} marked paid` +
    (actor ? ` by ${actor.fullName || actor.id}` : '')
  );
  return result.modifiedCount;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Signed effect of an entry on exposure: debits raise it, credits reduce it.
 * A reserve_adjust already carries its own sign, so the two compose correctly.
 */
const SIGNED_AMOUNT = {
  $multiply: [
    '$amountMinor',
    { $cond: [{ $eq: ['$direction', 'debit'] }, 1, -1] },
  ],
};

/**
 * Compute the financial position for a scope, straight from the entries.
 *
 * Implements the formula in spec §16:
 *   claim + interest + legal costs + court costs + expert costs − recoveries
 *   = net legal exposure
 *
 * Reserve entries are excluded from net exposure: a reserve is an estimate of
 * what we expect to pay, not money owed. Mixing the two double-counts every
 * matter — which is the single easiest way to make this module report nonsense.
 *
 * @param {Object} scope  one of { thirdPartyClaim } | { legalCase } | { claim } | { company }
 * @returns {Promise<Object>} position
 */
async function position(scope) {
  const match = buildMatch(scope);

  const rows = await LegalLedgerEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: { entryType: '$entryType', reserveBucket: '$reserveBucket' },
        signedMinor: { $sum: SIGNED_AMOUNT },
        count: { $sum: 1 },
      },
    },
  ]);

  const paid = await paidTotal(match);
  return computePosition(rows, paid);
}

/**
 * The exposure arithmetic, as a pure function.
 *
 * Deliberately separated from the database so the invariant that matters — that
 * the aggregation always equals spec §16's formula, for any sequence of
 * postings and reversals — can be property-tested without a Mongo instance.
 * See scripts/test-legal-ledger.js.
 *
 * @param {Array<{_id:{entryType:string, reserveBucket:string}, signedMinor:number}>} rows
 * @param {number} [paidMinor=0]
 * @returns {Object} position
 */
function computePosition(rows, paidMinor = 0) {
  const byType = {};
  const reserves = { claim: 0, legal: 0, judgment: 0 };

  for (const row of rows) {
    const { entryType, reserveBucket } = row._id;
    byType[entryType] = (byType[entryType] || 0) + row.signedMinor;
    if (LEDGER_ENTRY_TYPES[entryType]?.reserve && reserveBucket) {
      reserves[reserveBucket] = (reserves[reserveBucket] || 0) + row.signedMinor;
    }
  }

  const amount = (t) => byType[t] || 0;

  const settlementAndJudgment = sumMinor([amount('settlement'), amount('judgment')]);
  const interest = amount('interest');
  const legalCosts = sumMinor([
    amount('legal_fee'),
    amount('disbursement'),
    amount('claimant_costs'),
  ]);
  const courtCosts = amount('court_fee');
  const expertCosts = sumMinor([
    amount('expert_fee'),
    amount('medical_report_fee'),
    amount('investigation_fee'),
  ]);
  // Recoveries and write-offs are credits, so their signed sum is already
  // negative — adding it subtracts, as the formula requires.
  const recoveriesAndWriteOffs = sumMinor([amount('recovery'), amount('write_off')]);

  const netExposureMinor = sumMinor([
    settlementAndJudgment,
    interest,
    legalCosts,
    courtCosts,
    expertCosts,
    recoveriesAndWriteOffs,
  ]);

  return {
    reserveClaimMinor: reserves.claim || 0,
    reserveLegalMinor: reserves.legal || 0,
    reserveJudgmentMinor: reserves.judgment || 0,
    reserveTotalMinor: sumMinor([reserves.claim || 0, reserves.legal || 0, reserves.judgment || 0]),

    settlementAndJudgmentMinor: settlementAndJudgment,
    interestMinor: interest,
    legalCostsMinor: legalCosts,
    courtCostsMinor: courtCosts,
    expertCostsMinor: expertCosts,
    // Reported positive for readability; it is subtracted in the net above.
    recoveriesMinor: -recoveriesAndWriteOffs,

    feesToDateMinor: sumMinor([legalCosts, courtCosts, expertCosts]),
    paidToDateMinor: paidMinor,
    netExposureMinor,

    byType,
    recomputedAt: new Date(),
  };
}

/** Money that has actually left the business, as opposed to accrued. */
async function paidTotal(match) {
  const [row] = await LegalLedgerEntry.aggregate([
    { $match: { ...match, status: 'paid', direction: 'debit' } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]);
  return row?.total || 0;
}

/**
 * Aggregate exposure across every third-party claimant on one accident.
 *
 * This is what the policy's aggregate limit is measured against — a limit bites
 * on the accident, not on each claimant separately, so a per-claimant view can
 * look comfortable while the accident as a whole is well over.
 *
 * @param {*} claimId
 * @returns {Promise<Object>}
 */
async function exposureByAccident(claimId) {
  const rows = await LegalLedgerEntry.aggregate([
    { $match: { claim: toObjectId(claimId) } },
    {
      $group: {
        _id: '$thirdPartyClaim',
        signedMinor: { $sum: SIGNED_AMOUNT },
      },
    },
  ]);

  const perClaimant = rows.map((r) => ({
    thirdPartyClaim: r._id,
    netMinor: r.signedMinor,
  }));

  return {
    claim: claimId,
    perClaimant,
    totalMinor: sumMinor(perClaimant.map((p) => p.netMinor)),
    claimantCount: perClaimant.filter((p) => p.thirdPartyClaim).length,
  };
}

/**
 * The ledger for one scope, newest first — what the Financials tab renders.
 */
async function entries(scope, { limit = 200, skip = 0 } = {}) {
  return LegalLedgerEntry.find(buildMatch(scope))
    .sort({ occurredAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildMatch(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new ApiError(400, 'A ledger scope is required');
  }
  const keys = ['thirdPartyClaim', 'legalCase', 'claim', 'company'];
  const key = keys.find((k) => scope[k]);
  if (!key) {
    throw new ApiError(400, `Ledger scope must be one of: ${keys.join(', ')}`);
  }
  const match = { [key]: toObjectId(scope[key]) };
  // Callers may narrow further (e.g. a reporting period).
  if (scope.from || scope.to) {
    match.occurredAt = {};
    if (scope.from) match.occurredAt.$gte = new Date(scope.from);
    if (scope.to) match.occurredAt.$lte = new Date(scope.to);
  }
  return match;
}

function toObjectId(v) {
  return v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));
}

module.exports = {
  post,
  reverse,
  markSourcePaid,
  position,
  computePosition,
  entries,
  exposureByAccident,
};
