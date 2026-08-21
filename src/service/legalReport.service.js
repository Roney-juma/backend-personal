const mongoose = require('mongoose');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Settlement = require('../models/settlement.model');
const LegalLedgerEntry = require('../models/legalLedgerEntry.model');
const money = require('../utils/money');

/**
 * Management reporting (spec §25).
 *
 * A note that applies to every aggregation here: the soft-delete plugin works
 * through query middleware, which aggregation pipelines BYPASS. Every $match
 * below therefore carries an explicit `deletedAt: null`. Without it a deleted
 * claim silently reappears in the exposure totals, and a report that
 * occasionally overstates the book is worse than no report.
 */

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/** Base match for every report: one tenant, live records only. */
const scope = (company, extra = {}) => ({
  ...(company ? { company: oid(company) } : {}),
  deletedAt: null,
  ...extra,
});

/**
 * Monthly legal report — the movement in the book over a period.
 *
 * Opening/new/closed/closing reconcile: opening + new − closed = closing. If
 * they ever fail to, the numbers are wrong and should be treated as such rather
 * than explained away.
 */
async function monthly({ company, from, to }) {
  const start = from ? new Date(from) : startOfMonth(new Date());
  const end = to ? new Date(to) : new Date();

  const CLOSED = ['settled', 'paid', 'closed', 'time_barred'];

  const [openingCount, newCount, closedCount, closingCount] = await Promise.all([
    // Registered before the window and not yet closed at that point.
    ThirdPartyClaim.countDocuments(
      scope(company, {
        createdAt: { $lt: start },
        $or: [{ closedAt: null }, { closedAt: { $gte: start } }],
      })
    ),
    ThirdPartyClaim.countDocuments(scope(company, { createdAt: { $gte: start, $lte: end } })),
    ThirdPartyClaim.countDocuments(
      scope(company, { status: { $in: CLOSED }, updatedAt: { $gte: start, $lte: end } })
    ),
    ThirdPartyClaim.countDocuments(
      scope(company, { status: { $nin: CLOSED }, createdAt: { $lte: end } })
    ),
  ]);

  const [byStatus, byType, settlements, ledger] = await Promise.all([
    ThirdPartyClaim.aggregate([
      { $match: scope(company, { status: { $nin: CLOSED } }) },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          exposureMinor: { $sum: { $ifNull: ['$exposure.cappedMinor', 0] } },
          reserveMinor: { $sum: { $ifNull: ['$reserve.currentMinor', 0] } },
        },
      },
      { $sort: { exposureMinor: -1 } },
    ]),

    ThirdPartyClaim.aggregate([
      { $match: scope(company, { status: { $nin: CLOSED } }) },
      {
        $group: {
          _id: '$claimType',
          count: { $sum: 1 },
          exposureMinor: { $sum: { $ifNull: ['$exposure.cappedMinor', 0] } },
        },
      },
      { $sort: { exposureMinor: -1 } },
    ]),

    Settlement.aggregate([
      {
        $match: scope(company, {
          status: { $in: ['executed', 'paid'] },
          executedAt: { $gte: start, $lte: end },
        }),
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalMinor: { $sum: '$totalMinor' },
          // How settled amounts compared with what had been reserved — the
          // single most useful number for judging reserving accuracy.
          reservedMinor: { $sum: { $ifNull: ['$reserveAtProposalMinor', 0] } },
        },
      },
    ]),

    LegalLedgerEntry.aggregate([
      { $match: { ...(company ? { company: oid(company) } : {}), occurredAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$entryType',
          signedMinor: {
            $sum: { $multiply: ['$amountMinor', { $cond: [{ $eq: ['$direction', 'debit'] }, 1, -1] }] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byEntryType = Object.fromEntries(ledger.map((r) => [r._id, r.signedMinor]));
  const spend = (types) => types.reduce((acc, t) => acc + (byEntryType[t] || 0), 0);

  const settled = settlements[0] || { count: 0, totalMinor: 0, reservedMinor: 0 };

  return {
    period: { from: start, to: end },
    movement: {
      opening: openingCount,
      new: newCount,
      closed: closedCount,
      closing: closingCount,
      // Surfaced rather than hidden: a mismatch means something moved in a way
      // the status model does not describe, and that is worth knowing.
      reconciles: openingCount + newCount - closedCount === closingCount,
    },
    byStatus: byStatus.map((r) => ({
      status: r._id,
      count: r.count,
      exposureMinor: r.exposureMinor,
      exposure: money.toMajor(r.exposureMinor),
      reserveMinor: r.reserveMinor,
    })),
    byClaimType: byType.map((r) => ({
      claimType: r._id,
      count: r.count,
      exposureMinor: r.exposureMinor,
      exposure: money.toMajor(r.exposureMinor),
    })),
    settlements: {
      count: settled.count,
      totalMinor: settled.totalMinor,
      total: money.toMajor(settled.totalMinor),
      reservedMinor: settled.reservedMinor,
      // Positive = settled for less than reserved.
      savingMinor: settled.reservedMinor - settled.totalMinor,
      saving: money.toMajor(settled.reservedMinor - settled.totalMinor),
    },
    expenses: {
      legalFeesMinor: spend(['legal_fee', 'disbursement']),
      courtFeesMinor: spend(['court_fee']),
      expertFeesMinor: spend(['expert_fee', 'medical_report_fee', 'investigation_fee']),
      claimantCostsMinor: spend(['claimant_costs']),
      interestMinor: spend(['interest']),
      totalMinor: spend([
        'legal_fee', 'disbursement', 'court_fee',
        'expert_fee', 'medical_report_fee', 'investigation_fee',
        'claimant_costs', 'interest',
      ]),
    },
    // Credits, so the signed sum is negative — reported positive for reading.
    recoveriesMinor: -spend(['recovery']),
    writeOffsMinor: -spend(['write_off']),
  };
}

/**
 * Aging report — how long open claims have been sitting (spec §25).
 *
 * Aged from first notification rather than from registration in AVICS: a claim
 * we learned about late is already old, and dating it from when we happened to
 * key it in flatters the numbers.
 */
async function aging({ company }) {
  const CLOSED = ['settled', 'paid', 'closed', 'time_barred'];
  const now = new Date();

  const BUCKETS = [
    { key: '0-90', label: '0–90 days', minDays: 0, maxDays: 90 },
    { key: '91-180', label: '91–180 days', minDays: 91, maxDays: 180 },
    { key: '181-365', label: '181–365 days', minDays: 181, maxDays: 365 },
    { key: '1-2y', label: '1–2 years', minDays: 366, maxDays: 730 },
    { key: '2y+', label: 'Over 2 years', minDays: 731, maxDays: null },
  ];

  const claims = await ThirdPartyClaim.find(scope(company, { status: { $nin: CLOSED } }))
    .select('firstNotifiedAt createdAt exposure reserve claimType status limitation referenceNumber party')
    .lean();

  const buckets = BUCKETS.map((b) => ({
    ...b,
    count: 0,
    exposureMinor: 0,
    reserveMinor: 0,
    claims: [],
  }));

  for (const claim of claims) {
    const from = claim.firstNotifiedAt || claim.createdAt;
    const ageDays = Math.floor((now.getTime() - new Date(from).getTime()) / 86400000);

    const bucket =
      buckets.find((b) => ageDays >= b.minDays && (b.maxDays === null || ageDays <= b.maxDays)) ||
      buckets[buckets.length - 1];

    bucket.count += 1;
    bucket.exposureMinor += claim.exposure?.cappedMinor || 0;
    bucket.reserveMinor += claim.reserve?.currentMinor || 0;
    // A sample, not the whole bucket — this is a summary report.
    if (bucket.claims.length < 10) {
      bucket.claims.push({
        _id: claim._id,
        referenceNumber: claim.referenceNumber,
        party: claim.party?.name,
        ageDays,
        exposureMinor: claim.exposure?.cappedMinor || 0,
      });
    }
  }

  return {
    generatedAt: now,
    totalOpen: claims.length,
    totalExposureMinor: buckets.reduce((a, b) => a + b.exposureMinor, 0),
    buckets: buckets.map((b) => ({
      ...b,
      exposure: money.toMajor(b.exposureMinor),
      reserve: money.toMajor(b.reserveMinor),
    })),
  };
}

/**
 * Reserving accuracy — settled amounts against what had been reserved, by
 * injury type.
 *
 * This is the feedback loop that lets an insurer improve its own reserving
 * schedule from its own closed matters rather than from a number someone
 * guessed years ago.
 */
async function reservingAccuracy({ company, from, to }) {
  const start = from ? new Date(from) : new Date(Date.now() - 365 * 86400000);
  const end = to ? new Date(to) : new Date();

  const rows = await Settlement.aggregate([
    {
      $match: scope(company, {
        status: { $in: ['executed', 'paid'] },
        executedAt: { $gte: start, $lte: end },
      }),
    },
    {
      $lookup: {
        from: 'thirdpartyclaims',
        localField: 'thirdPartyClaim',
        foreignField: '_id',
        as: 'tpc',
      },
    },
    { $unwind: '$tpc' },
    {
      $group: {
        _id: { injuryCode: '$tpc.injury.injuryCode', claimType: '$tpc.claimType' },
        count: { $sum: 1 },
        settledTotalMinor: { $sum: '$totalMinor' },
        reservedTotalMinor: { $sum: { $ifNull: ['$reserveAtProposalMinor', 0] } },
        avgSettledMinor: { $avg: '$totalMinor' },
        minSettledMinor: { $min: '$totalMinor' },
        maxSettledMinor: { $max: '$totalMinor' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  return {
    period: { from: start, to: end },
    rows: rows.map((r) => ({
      injuryCode: r._id.injuryCode || null,
      claimType: r._id.claimType,
      count: r.count,
      avgSettledMinor: Math.round(r.avgSettledMinor),
      avgSettled: money.toMajor(Math.round(r.avgSettledMinor)),
      minSettledMinor: r.minSettledMinor,
      maxSettledMinor: r.maxSettledMinor,
      settledTotalMinor: r.settledTotalMinor,
      reservedTotalMinor: r.reservedTotalMinor,
      // Negative means we were settling for more than we had reserved — the
      // direction that hurts.
      varianceMinor: r.reservedTotalMinor - r.settledTotalMinor,
      variance: money.toMajor(r.reservedTotalMinor - r.settledTotalMinor),
    })),
    note:
      rows.length < 5
        ? 'Too few closed settlements for these figures to be a reliable guide yet.'
        : null,
  };
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

module.exports = { monthly, aging, reservingAccuracy };
