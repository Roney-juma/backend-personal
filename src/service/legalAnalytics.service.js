const mongoose = require('mongoose');
const LegalCase = require('../models/legalCase.model');
const LegalEvent = require('../models/legalEvent.model');
const Advocate = require('../models/advocate.model');
const Settlement = require('../models/settlement.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const money = require('../utils/money');

/**
 * Analytics over closed and running matters.
 *
 * One rule applies to every figure here: report the SAMPLE SIZE alongside it and
 * suppress the conclusion when the sample is too small. An advocate with a 100%
 * win rate over two matters is not better than one at 70% over forty, and a
 * court "averaging 3 adjournments" across a single case is noise. Analytics that
 * present both with equal confidence get used to make decisions they cannot
 * support.
 *
 * Aggregation pipelines bypass the soft-delete middleware, so every $match
 * carries an explicit `deletedAt: null`.
 */

const MIN_SAMPLE = 5;

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const scope = (company, extra = {}) => ({
  ...(company ? { company: oid(company) } : {}),
  deletedAt: null,
  ...extra,
});

/**
 * Court performance — which courts cost the most, take the longest and adjourn
 * the most.
 *
 * The adjournment count is the interesting column and it exists only because
 * adjournments append rather than overwrite (see legalDiary.adjourn). A system
 * that mutated the date in place could not produce this table at all.
 */
async function courtPerformance({ company }) {
  const cases = await LegalCase.find(scope(company, { court: { $ne: null } }))
    .select('court courtStation status filedAt closedAt judgment thirdPartyClaims')
    .lean();

  if (!cases.length) return { courts: [], note: 'No matters have reached court yet.' };

  const caseIds = cases.map((c) => c._id);
  const [adjournments, settlements] = await Promise.all([
    LegalEvent.aggregate([
      { $match: { legalCase: { $in: caseIds }, status: 'adjourned', deletedAt: null } },
      { $group: { _id: '$legalCase', count: { $sum: 1 } } },
    ]),
    Settlement.find({ legalCase: { $in: caseIds }, status: { $in: ['executed', 'paid'] } })
      .select('legalCase totalMinor')
      .lean(),
  ]);

  const adjournmentsByCase = Object.fromEntries(adjournments.map((a) => [String(a._id), a.count]));
  const settledByCase = {};
  for (const s of settlements) {
    settledByCase[String(s.legalCase)] = (settledByCase[String(s.legalCase)] || 0) + s.totalMinor;
  }

  const byCourt = {};
  for (const c of cases) {
    const key = c.court;
    const bucket = (byCourt[key] ||= {
      court: key,
      matters: 0,
      closed: 0,
      adjournments: 0,
      durationDays: [],
      settledMinor: 0,
      judgmentsForInsurer: 0,
      judgmentsAgainst: 0,
    });

    bucket.matters += 1;
    bucket.adjournments += adjournmentsByCase[String(c._id)] || 0;
    bucket.settledMinor += settledByCase[String(c._id)] || 0;

    if (c.closedAt && c.filedAt) {
      bucket.closed += 1;
      bucket.durationDays.push((new Date(c.closedAt) - new Date(c.filedAt)) / 86400000);
    }
    if (c.judgment?.liabilityOutcome) {
      if (['for_insurer', 'dismissed', 'struck_out'].includes(c.judgment.liabilityOutcome)) {
        bucket.judgmentsForInsurer += 1;
      } else {
        bucket.judgmentsAgainst += 1;
      }
    }
  }

  const courts = Object.values(byCourt)
    .map((b) => {
      const reliable = b.matters >= MIN_SAMPLE;
      return {
        court: b.court,
        matters: b.matters,
        closed: b.closed,
        avgAdjournments: Math.round((b.adjournments / b.matters) * 10) / 10,
        avgDurationDays: b.durationDays.length
          ? Math.round(b.durationDays.reduce((x, y) => x + y, 0) / b.durationDays.length)
          : null,
        settledMinor: b.settledMinor,
        settled: money.toMajor(b.settledMinor),
        judgmentsForInsurer: b.judgmentsForInsurer,
        judgmentsAgainst: b.judgmentsAgainst,
        // Stated rather than implied: a reader should not have to count rows to
        // know whether a number means anything.
        reliable,
        note: reliable ? null : `Only ${b.matters} matter(s) — indicative only`,
      };
    })
    .sort((a, b) => b.matters - a.matters);

  return { courts, minimumSample: MIN_SAMPLE };
}

/**
 * The advocate scorecard.
 *
 * Reads the performance block each advocate already carries (recomputed nightly
 * from cases and the ledger) rather than recalculating, so the table and the
 * allocation engine can never disagree.
 */
async function advocateScorecard({ company }) {
  const advocates = await Advocate.find(scope(company, { approved: true }))
    .select('name firm counties courts performance active contractExpiry')
    .lean();

  const rows = advocates
    .map((a) => {
      const p = a.performance || {};
      const reliable = (p.closedMatters || 0) >= MIN_SAMPLE;
      return {
        _id: a._id,
        name: a.name,
        firm: a.firm?.name,
        active: a.active,
        openMatters: p.openMatters || 0,
        closedMatters: p.closedMatters || 0,
        successfulDefences: p.successfulDefences || 0,
        // Withheld below the threshold rather than shown with a caveat — a
        // number on the page gets compared whatever the footnote says.
        winRate: reliable ? p.winRate || 0 : null,
        avgDurationDays: reliable ? p.avgDurationDays || 0 : null,
        savingsMinor: reliable ? p.savingsMinor || 0 : null,
        avgSettlementMinor: reliable ? p.avgSettlementMinor || 0 : null,
        overdueActions: p.overdueActions || 0,
        reliable,
        note: reliable ? null : `${p.closedMatters || 0} closed matter(s) — too few to rate`,
        recomputedAt: p.recomputedAt,
      };
    })
    .sort((a, b) => (b.savingsMinor ?? -1) - (a.savingsMinor ?? -1));

  return { advocates: rows, minimumSample: MIN_SAMPLE };
}

/**
 * Reserving accuracy by injury type — the feedback loop.
 *
 * Compares what claims of each injury type actually settled at against what the
 * tenant's own schedule said to reserve. This is what lets an insurer improve
 * that schedule from its own closed matters rather than from a figure someone
 * chose years ago, and it is the reason Settlement snapshots
 * `reserveAtProposalMinor` at proposal time.
 */
async function reservingFeedback({ company, months = 24 }) {
  const since = new Date(Date.now() - months * 30 * 86400000);

  const settlements = await Settlement.aggregate([
    {
      $match: scope(company, {
        status: { $in: ['executed', 'paid'] },
        executedAt: { $gte: since },
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
        _id: { code: '$tpc.injury.injuryCode', claimType: '$tpc.claimType' },
        count: { $sum: 1 },
        settledValues: { $push: '$totalMinor' },
        totalSettledMinor: { $sum: '$totalMinor' },
        totalReservedMinor: { $sum: { $ifNull: ['$reserveAtProposalMinor', 0] } },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const legalConfig = require('./legalConfig.service');
  const config = await legalConfig.get(company);
  const schedule = Object.fromEntries((config.reservingSchedule || []).map((b) => [b.code, b]));

  const rows = settlements.map((s) => {
    const values = [...s.settledValues].sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const band = schedule[s._id.code];
    const reliable = s.count >= MIN_SAMPLE;

    // The actionable output: what the schedule should say, based on what these
    // claims actually settle at.
    let recommendation = null;
    if (reliable && band) {
      if (!band.defaultMinor) {
        recommendation = `Set a default of about ${money.formatMinor(median)} — currently unset.`;
      } else if (median > band.defaultMinor * 1.25) {
        recommendation =
          `Under-reserving: settling around ${money.formatMinor(median)} against a ` +
          `${money.formatMinor(band.defaultMinor)} default.`;
      } else if (median < band.defaultMinor * 0.75) {
        recommendation =
          `Over-reserving: settling around ${money.formatMinor(median)} against a ` +
          `${money.formatMinor(band.defaultMinor)} default.`;
      }
    }

    return {
      injuryCode: s._id.code || null,
      claimType: s._id.claimType,
      label: band?.label || s._id.code || s._id.claimType,
      count: s.count,
      medianSettledMinor: median,
      medianSettled: money.toMajor(median),
      minSettledMinor: values[0],
      maxSettledMinor: values[values.length - 1],
      scheduleDefaultMinor: band?.defaultMinor ?? null,
      varianceMinor: s.totalReservedMinor - s.totalSettledMinor,
      reliable,
      recommendation,
      note: reliable ? null : `${s.count} settled matter(s) — not yet a guide`,
    };
  });

  return {
    period: { from: since, to: new Date() },
    rows,
    minimumSample: MIN_SAMPLE,
    note: rows.every((r) => !r.reliable)
      ? 'Not enough closed settlements yet for reserving feedback to be meaningful.'
      : null,
  };
}

/**
 * Similar historical matters — what claims like this one actually settled at.
 *
 * Deliberately a plain query rather than anything learned: same injury code or
 * claim type, comparable liability apportionment, already settled. A legal
 * officer wants the comparables to be inspectable, and a list they can open and
 * check is worth more than a single predicted number they cannot.
 */
async function similarMatters(tpcId, { limit = 10 } = {}) {
  const tpc = await ThirdPartyClaim.findById(tpcId).lean();
  if (!tpc) return { comparables: [], note: 'Claim not found' };

  const share = tpc.liability?.insuredSharePercent;

  const filter = {
    company: tpc.company,
    _id: { $ne: tpc._id },
    status: { $in: ['settled', 'paid', 'closed'] },
    settledAmountMinor: { $gt: 0 },
    deletedAt: null,
    ...(tpc.injury?.injuryCode
      ? { 'injury.injuryCode': tpc.injury.injuryCode }
      : { claimType: tpc.claimType }),
  };

  // Comparable fault: a claim settled at 100% liability is not a comparable for
  // one at 30%, and averaging across them produces a number that describes
  // nothing.
  if (Number.isFinite(share)) {
    filter['liability.insuredSharePercent'] = { $gte: Math.max(0, share - 20), $lte: Math.min(100, share + 20) };
  }

  const comparables = await ThirdPartyClaim.find(filter)
    .select('referenceNumber claimType injury liability settledAmountMinor settledAt quantum')
    .sort({ settledAt: -1 })
    .limit(limit)
    .lean();

  const values = comparables.map((c) => c.settledAmountMinor).sort((a, b) => a - b);
  const median = values.length ? values[Math.floor(values.length / 2)] : null;

  return {
    basis: tpc.injury?.injuryCode ? `injury code ${tpc.injury.injuryCode}` : `claim type ${tpc.claimType}`,
    liabilityWindow: Number.isFinite(share) ? `${Math.max(0, share - 20)}–${Math.min(100, share + 20)}%` : null,
    count: comparables.length,
    medianSettledMinor: median,
    medianSettled: median === null ? null : money.toMajor(median),
    rangeMinor: values.length ? { min: values[0], max: values[values.length - 1] } : null,
    comparables,
    reliable: comparables.length >= MIN_SAMPLE,
    note:
      comparables.length >= MIN_SAMPLE
        ? null
        : `Only ${comparables.length} comparable matter(s) — treat as anecdotal, not a guide.`,
  };
}

module.exports = {
  courtPerformance,
  advocateScorecard,
  reservingFeedback,
  similarMatters,
  MIN_SAMPLE,
};
