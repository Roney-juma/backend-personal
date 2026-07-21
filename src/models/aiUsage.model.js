const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * One document per model call — the durable AI spend ledger.
 *
 * Written fire-and-forget from the single LLM choke point (src/ai/llm/claude.js),
 * so every feature (agents, analyzers, photo gate) is covered automatically.
 * Aggregate at read time: per claim, per feature, per day, per model.
 *
 * Calls made before a claim exists (the intake conversation) carry a
 * `sessionKey`; the claimId is stamped onto those rows when the claim is filed,
 * so a claim's lifecycle cost includes the chat that created it.
 */
const aiUsageSchema = new Schema({
  feature: { type: String, required: true, index: true },
  // 'intake' | 'fraud' | 'assessment' | 'garage' | 'reassessment'
  stage: { type: String },
  model: { type: String, required: true },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cacheReadTokens: { type: Number, default: 0 },
  cacheWriteTokens: { type: Number, default: 0 },
  usd: { type: Number, default: 0 }, // canonical cost — KES is a snapshot at today's rate
  kes: { type: Number, default: 0 },
  // Tenant the spend belongs to (for per-company AI budgets). Stamped from the
  // claim/customer in scope at call time; backfilled onto intake-session rows
  // when the claim is filed.
  company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', index: true, default: null },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  userId: { type: Schema.Types.ObjectId }, // staff identity (staff-assistant calls)
  sessionKey: { type: String, index: true },
}, { timestamps: true });

aiUsageSchema.index({ createdAt: 1 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
