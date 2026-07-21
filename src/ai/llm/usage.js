/**
 * Durable AI usage accounting.
 *
 * recordUsage() writes one AiUsage document per model call. Writes are
 * fire-and-forget so a DB hiccup can never fail or slow an AI response.
 *
 * Intake calls happen before a claim exists, so they carry a sessionKey;
 * attributeSessionToClaim() stamps the claimId onto those rows the moment the
 * claim is filed, making per-claim lifecycle cost include the conversation
 * (and photo checks) that created the claim.
 */
const AiUsage = require('../../models/aiUsage.model');
const { estimateUsd, USD_TO_KES } = require('./cost');
const logger = require('../../middlewheres/logger');

/**
 * @param {Object} response  Raw Anthropic message response (model + usage).
 * @param {Object} [meta]    { feature, stage, claimId, customerId, userId, sessionKey, company }
 */
const recordUsage = (response, meta = {}) => {
  try {
    const u = response.usage || {};
    const usd = estimateUsd(response.model, u);
    AiUsage.create({
      feature: meta.feature || 'unknown',
      stage: meta.stage,
      model: response.model,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      usd,
      kes: usd * USD_TO_KES,
      company: meta.company || undefined,
      claimId: meta.claimId || null,
      customerId: meta.customerId || undefined,
      userId: meta.userId || undefined,
      sessionKey: meta.sessionKey || undefined,
    }).catch((err) => logger.warn(`[ai-usage] persist failed: ${err.message}`));
  } catch (err) {
    logger.warn(`[ai-usage] persist failed: ${err.message}`);
  }
};

/** Attach a freshly filed claim to all usage rows from its intake session. */
const attributeSessionToClaim = (sessionKey, claimId) => {
  if (!sessionKey || !claimId) return;
  // Resolve the claim's tenant so pre-claim session rows pick up the company
  // alongside the claimId (required lazily to avoid a model load cycle).
  const Claim = require('../../models/claim.model');
  Claim.findById(claimId).select('company').lean()
    .then((claim) => {
      const update = { claimId };
      if (claim && claim.company) update.company = claim.company;
      return AiUsage.updateMany({ sessionKey, claimId: null }, { $set: update });
    })
    .catch((err) => logger.warn(`[ai-usage] claim attribution failed: ${err.message}`));
};

module.exports = { recordUsage, attributeSessionToClaim };
