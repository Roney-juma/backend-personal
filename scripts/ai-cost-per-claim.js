/**
 * AI cost vs claim volume for a month — the client-facing "what does AI cost us
 * per claim" number.
 *
 * Usage:
 *   node scripts/ai-cost-per-claim.js                 # current month
 *   node scripts/ai-cost-per-claim.js --month 2026-07
 *   node scripts/ai-cost-per-claim.js --company <insuranceCompanyId>
 *   node scripts/ai-cost-per-claim.js --json          # machine-readable
 *
 * Three claim counts are reported because they answer different questions:
 *   filed       — claims created in the month (the volume the client sees)
 *   aiTouched   — claims that actually incurred AI spend in the month
 *   completed   — claims that reached a terminal status in the month
 * Cost-per-claim is quoted against `filed` (the headline) and `aiTouched`.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const AiUsage = require('../src/models/aiUsage.model');
const Claim = require('../src/models/claim.model');
const { foldIntoActions } = require('../src/service/aiUsage.service');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const TERMINAL = ['Completed', 'Rejected'];

const monthRange = (spec) => {
  const now = new Date();
  const [y, m] = spec
    ? spec.split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - 1);
  return { from, to, label: `${y}-${String(m).padStart(2, '0')}` };
};

const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const { from, to, label } = monthRange(arg('month'));
  const company = arg('company');
  if (company && !mongoose.Types.ObjectId.isValid(company)) {
    throw new Error(`Invalid company id "${company}"`);
  }
  const companyId = company ? new mongoose.Types.ObjectId(company) : null;

  await mongoose.connect(process.env.MONGO_URI);

  const usageMatch = { createdAt: { $gte: from, $lte: to } };
  if (companyId) usageMatch.company = companyId;
  const claimMatch = { createdAt: { $gte: from, $lte: to } };
  if (companyId) claimMatch.company = companyId;

  const [usageTotals, perFeature, aiTouched, filed, completed] = await Promise.all([
    AiUsage.aggregate([
      { $match: usageMatch },
      { $group: { _id: null, calls: { $sum: 1 }, usd: { $sum: '$usd' }, kes: { $sum: '$kes' },
                  inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' },
                  cacheReadTokens: { $sum: '$cacheReadTokens' }, cacheWriteTokens: { $sum: '$cacheWriteTokens' } } },
    ]),
    AiUsage.aggregate([
      { $match: usageMatch },
      { $group: { _id: { feature: '$feature', stage: '$stage' }, calls: { $sum: 1 },
                  inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' },
                  cacheReadTokens: { $sum: '$cacheReadTokens' }, cacheWriteTokens: { $sum: '$cacheWriteTokens' },
                  usd: { $sum: '$usd' }, kes: { $sum: '$kes' } } },
      { $sort: { usd: -1 } },
    ]).then((rows) => rows.map(({ _id, ...s }) => ({ feature: _id.feature, stage: _id.stage || null, ...s }))),
    AiUsage.distinct('claimId', { ...usageMatch, claimId: { $ne: null } }).then((ids) => ids.length),
    Claim.countDocuments(claimMatch),
    Claim.countDocuments({ ...claimMatch, status: { $in: TERMINAL } }),
  ]);

  const t = usageTotals[0] || { calls: 0, usd: 0, kes: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const per = (count) => (count ? { usd: t.usd / count, kes: t.kes / count } : null);

  const result = {
    month: label,
    from, to,
    company: company || 'all',
    claims: { filed, aiTouched, completed },
    ai: {
      calls: t.calls,
      totalTokens: t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
      usd: t.usd, kes: t.kes,
    },
    costPerClaimFiled: per(filed),
    costPerClaimAiTouched: per(aiTouched),
    actions: foldIntoActions(perFeature),
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nAI cost vs claim volume — ${label}${company ? ` (company ${company})` : ' (all tenants)'}`);
    console.log(`${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}\n`);
    console.log(`Claims filed this month      : ${filed}`);
    console.log(`  of which AI-touched        : ${aiTouched}`);
    console.log(`Claims closed this month     : ${completed}   (${TERMINAL.join(', ')})`);
    console.log(`\nAI model calls               : ${t.calls}`);
    console.log(`AI tokens                    : ${(t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens).toLocaleString()}`);
    console.log(`AI spend                     : USD ${money(t.usd)}  /  KES ${money(t.kes)}`);
    if (filed) console.log(`Cost per claim filed         : USD ${money(t.usd / filed)}  /  KES ${money(t.kes / filed)}`);
    if (aiTouched) console.log(`Cost per AI-touched claim    : USD ${money(t.usd / aiTouched)}  /  KES ${money(t.kes / aiTouched)}`);
    if (result.actions.length) {
      console.log(`\nWhere the spend went:`);
      for (const a of result.actions) {
        const share = t.usd ? ((a.usd / t.usd) * 100).toFixed(1) : '0.0';
        console.log(`  ${a.label.padEnd(34)} ${String(a.calls).padStart(6)} calls   USD ${money(a.usd).padStart(9)}   ${share.padStart(5)}%`);
      }
    }
    console.log('');
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
