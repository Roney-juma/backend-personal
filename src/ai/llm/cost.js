/**
 * Lightweight cost accounting for AI calls.
 *
 * - Estimates KES cost per turn from token usage (rough, for logging/alerts).
 * - Enforces a per-conversation token ceiling so a single intake session
 *   can never run away (see AI_MAX_TOKENS_PER_CLAIM).
 */
const logger = require('../../middlewheres/logger');

const USD_TO_KES = Number(process.env.USD_TO_KES || 130);
const MAX_TOKENS_PER_CONVO = Number(process.env.AI_MAX_TOKENS_PER_CLAIM || 20000);

// Per-1M-token pricing (USD). Opus 4.8 defaults; adjust if the agent model changes.
const PRICING = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
};

// Responses carry dated ids ('claude-haiku-4-5-20251001'); match by prefix so
// they don't silently fall back to Opus rates.
const priceFor = (model) => {
  const id = String(model || '');
  const key = Object.keys(PRICING).find((k) => id.startsWith(k));
  return PRICING[key] || PRICING['claude-opus-4-8'];
};

// Cache reads bill at ~0.1x the input rate, cache writes at 1.25x.
const estimateUsd = (model, usage = {}) => {
  const p = priceFor(model);
  return (
    (usage.input_tokens || 0) * p.in +
    (usage.output_tokens || 0) * p.out +
    (usage.cache_read_input_tokens || 0) * p.in * 0.1 +
    (usage.cache_creation_input_tokens || 0) * p.in * 1.25
  ) / 1_000_000;
};

const estimateKes = (model, usage) => estimateUsd(model, usage) * USD_TO_KES;

/**
 * Accumulates token spend across a multi-call agent loop and trips a ceiling.
 * Construct one per conversation turn / request.
 */
class CostTracker {
  constructor(label = 'ai') {
    this.label = label;
    this.tokens = 0;
    this.kes = 0;
  }

  record(response) {
    const u = response.usage || {};
    this.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
    this.kes += estimateKes(response.model, u);
    return this;
  }

  exceeded() {
    return this.tokens >= MAX_TOKENS_PER_CONVO;
  }

  flush() {
    logger.info(`[ai] ${this.label} spend tokens=${this.tokens} ~KES ${this.kes.toFixed(2)}`);
  }
}

module.exports = { CostTracker, estimateKes, estimateUsd, MAX_TOKENS_PER_CONVO, USD_TO_KES };
