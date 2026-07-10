/**
 * AI usage reporting over the AiUsage ledger (one row per model call).
 */
const mongoose = require('mongoose');
const AiUsage = require('../models/aiUsage.model');

const SUM_FIELDS = {
  calls: { $sum: 1 },
  inputTokens: { $sum: '$inputTokens' },
  outputTokens: { $sum: '$outputTokens' },
  cacheReadTokens: { $sum: '$cacheReadTokens' },
  cacheWriteTokens: { $sum: '$cacheWriteTokens' },
  usd: { $sum: '$usd' },
  kes: { $sum: '$kes' },
};

const totalsOf = (rows) =>
  rows.reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      cacheReadTokens: t.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens + r.cacheWriteTokens,
      usd: t.usd + r.usd,
      kes: t.kes + r.kes,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, kes: 0 }
  );

/**
 * Full lifecycle cost of one claim: intake conversation + photo gate + fraud
 * pipeline + every continuity check, broken down by feature/stage.
 */
const claimLifecycleCost = async (claimId) => {
  const rows = await AiUsage.aggregate([
    { $match: { claimId: new mongoose.Types.ObjectId(claimId) } },
    { $group: { _id: { feature: '$feature', stage: '$stage' }, ...SUM_FIELDS } },
    { $sort: { usd: -1 } },
  ]);

  const breakdown = rows.map(({ _id, ...sums }) => ({
    feature: _id.feature,
    stage: _id.stage || null,
    ...sums,
  }));

  return { claimId, totals: totalsOf(breakdown), breakdown };
};

const GROUPINGS = {
  day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
  month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
  feature: '$feature',
  model: '$model',
  claim: '$claimId',
};

/**
 * Roll up usage for a period.
 * @param {Object} opts { from?: Date, to?: Date, groupBy?: 'day'|'month'|'feature'|'model'|'claim' }
 */
const usageReport = async ({ from, to, groupBy = 'day' } = {}) => {
  const groupExpr = GROUPINGS[groupBy];
  if (!groupExpr) {
    throw new Error(`Unsupported groupBy "${groupBy}" — use one of: ${Object.keys(GROUPINGS).join(', ')}`);
  }

  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lte = to;
  }

  const rows = await AiUsage.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: groupExpr, ...SUM_FIELDS } },
    { $sort: groupBy === 'day' || groupBy === 'month' ? { _id: 1 } : { usd: -1 } },
  ]);

  const breakdown = rows.map(({ _id, ...sums }) => ({ [groupBy]: _id, ...sums }));
  return { groupBy, from: from || null, to: to || null, totals: totalsOf(breakdown), breakdown };
};

module.exports = { claimLifecycleCost, usageReport };
