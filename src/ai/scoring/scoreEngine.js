const { weights, severityMultiplier, bands } = require('./weights');
const { complete } = require('../llm/claude');
const { CostTracker } = require('../llm/cost');

const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5-20251001';

const getBand = (score) => {
  if (score <= bands.low) return 'low';
  if (score <= bands.medium) return 'medium';
  return 'high';
};

/**
 * Aggregate signals into a 0–100 score + band.
 * Returns { score, band, reasoning, tokensUsed, kesSpent }
 */
const aggregate = async (signals, claim) => {
  let raw = 0;
  for (const sig of signals) {
    const w = weights[sig.type] || 5;
    const m = severityMultiplier[sig.severity] || 0.7;
    raw += w * m;
  }
  const score = Math.min(100, Math.round(raw));
  const band = getBand(score);

  // Generate plain-English reasoning summary (one cheap Claude call)
  let reasoning = '';
  let tokensUsed = 0;
  let kesSpent = 0;

  if (signals.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const tracker = new CostTracker('fraud-reasoning');
      const sigSummary = signals
        .map(s => `- ${s.type} (${s.severity}): ${s.explanation || s.evidence || ''}`)
        .join('\n');

      const vehicle = claim.vehiclesInvolved?.[0]?.licensePlate || String(claim._id);

      const resp = await complete({
        model: FAST_MODEL,
        maxTokens: 256,
        system: 'You are a fraud analyst assistant. Write a concise 2-3 sentence plain-English summary of why a claim was flagged, based on the signals provided. Be factual and neutral.',
        messages: [{
          role: 'user',
          content: `Claim: ${vehicle}\nRisk score: ${score}/100 (${band})\n\nSignals:\n${sigSummary}\n\nWrite the reasoning summary.`,
        }],
      });

      tracker.record(resp);
      tracker.flush();
      reasoning = resp.content?.[0]?.text?.trim() || '';
      tokensUsed = (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0);
      const { estimateKes } = require('../llm/cost');
      kesSpent = estimateKes(FAST_MODEL, resp.usage || {});
    } catch (_) {
      reasoning = `Score ${score}/100. ${signals.length} signal(s) triggered: ${signals.map(s => s.type).join(', ')}.`;
    }
  } else if (signals.length > 0) {
    reasoning = `Score ${score}/100. ${signals.length} signal(s) triggered: ${signals.map(s => s.type).join(', ')}.`;
  } else {
    reasoning = 'No suspicious signals detected.';
  }

  return { score, band, reasoning, tokensUsed, kesSpent };
};

module.exports = { aggregate, getBand };
