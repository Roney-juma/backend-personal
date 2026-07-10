/**
 * AI usage reporting over the AiUsage ledger (one row per model call).
 */
const mongoose = require('mongoose');
const AiUsage = require('../models/aiUsage.model');
const { actionFor } = require('../ai/features');

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
 * Fold per-feature/stage ledger rows into user-facing actions
 * ("Photo validation", "Fraud score check", "Claimant vs assessment", …).
 * Each action keeps its contributing feature rows so the detail stays available.
 */
const foldIntoActions = (breakdown) => {
  const byAction = new Map();
  for (const row of breakdown) {
    const { action, label } = actionFor(row.feature, row.stage);
    if (!byAction.has(action)) {
      byAction.set(action, {
        action, label,
        calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        totalTokens: 0, usd: 0, kes: 0, features: [],
      });
    }
    const a = byAction.get(action);
    a.calls += row.calls;
    a.inputTokens += row.inputTokens;
    a.outputTokens += row.outputTokens;
    a.cacheReadTokens += row.cacheReadTokens;
    a.cacheWriteTokens += row.cacheWriteTokens;
    a.totalTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    a.usd += row.usd;
    a.kes += row.kes;
    a.features.push(row);
  }
  return [...byAction.values()].sort((x, y) => y.usd - x.usd);
};

const featureStageRows = async (match) => {
  const rows = await AiUsage.aggregate([
    { $match: match },
    { $group: { _id: { feature: '$feature', stage: '$stage' }, ...SUM_FIELDS } },
    { $sort: { usd: -1 } },
  ]);
  return rows.map(({ _id, ...sums }) => ({
    feature: _id.feature,
    stage: _id.stage || null,
    ...sums,
  }));
};

/**
 * Full lifecycle cost of one claim: intake conversation + photo gate + fraud
 * pipeline + every continuity check.
 *
 * `actions` is the display-ready rollup (one row per lifecycle action, each with
 * its contributing features); `breakdown` is the raw per-feature/stage view.
 */
const claimLifecycleCost = async (claimId) => {
  const breakdown = await featureStageRows({ claimId: new mongoose.Types.ObjectId(claimId) });
  return { claimId, totals: totalsOf(breakdown), actions: foldIntoActions(breakdown), breakdown };
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
 * @param {Object} opts { from?: Date, to?: Date, groupBy?: 'day'|'month'|'feature'|'model'|'claim'|'action' }
 */
const usageReport = async ({ from, to, groupBy = 'day' } = {}) => {
  const groupExpr = GROUPINGS[groupBy];
  if (!groupExpr && groupBy !== 'action') {
    throw new Error(`Unsupported groupBy "${groupBy}" — use one of: ${Object.keys(GROUPINGS).join(', ')}, action`);
  }

  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lte = to;
  }

  // 'action' is derived from (feature, stage) in code, not a stored field.
  if (groupBy === 'action') {
    const breakdown = foldIntoActions(await featureStageRows(match));
    return { groupBy, from: from || null, to: to || null, totals: totalsOf(breakdown), breakdown };
  }

  const rows = await AiUsage.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: groupExpr, ...SUM_FIELDS } },
    { $sort: groupBy === 'day' || groupBy === 'month' ? { _id: 1 } : { usd: -1 } },
  ]);

  const breakdown = rows.map(({ _id, ...sums }) => ({ [groupBy]: _id, ...sums }));
  return { groupBy, from: from || null, to: to || null, totals: totalsOf(breakdown), breakdown };
};

module.exports = { claimLifecycleCost, usageReport, foldIntoActions };
