/**
 * Claim narrative analysis via Claude (fast model).
 * One structured call — flags contradictions, coached phrasing, implausible sequences.
 * Returns { signals: Signal[], tokensUsed, kesSpent }
 */
const { complete } = require('../llm/claude');
const { CostTracker, estimateKes } = require('../llm/cost');
const logger = require('../../middlewheres/logger');
const { FEATURES } = require('../features');

const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5-20251001';

// Cached at module load so repeat calls don't pay the prompt-write cost twice.
const SYSTEM_PROMPT = `You are a fraud detection specialist reviewing insurance claim narratives. Analyze the provided claim text for suspicious patterns.

Look for:
1. Internal contradictions between different parts of the narrative
2. Coached or templated phrasing (unusually formal, legal-sounding, or suspiciously vague language typical of prepared scripts)
3. Implausible event sequences (e.g. physics/timing impossibilities)
4. Descriptions that clearly mismatch the structured claim data (location, time, vehicle details)

Respond ONLY with valid JSON in this exact format — no other text:
{
  "signals": [
    {
      "type": "narrative_contradiction" | "templated_language" | "implausible_sequence" | "coached_phrasing",
      "severity": "low" | "medium" | "high",
      "explanation": "brief plain-English explanation of the specific issue found"
    }
  ]
}

If no issues are found, return: {"signals": []}`;

const run = async (claim) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { signals: [], tokensUsed: 0, kesSpent: 0 };
  }

  const descParts = [
    claim.incidentDetails?.description,
    claim.description,
    claim.damage?.yourVehicle,
    claim.damage?.otherVehicles,
    claim.damage?.property,
    claim.damagedParts,
  ].filter(Boolean);

  if (!descParts.length) {
    return { signals: [], tokensUsed: 0, kesSpent: 0 };
  }

  const narrative = descParts.join('\n\n');
  const vehicle = claim.vehiclesInvolved?.[0];
  const context = [
    `Incident date: ${claim.incidentDetails?.date || 'unknown'}`,
    `Incident time: ${claim.incidentDetails?.time || 'unknown'}`,
    `Location: ${claim.incidentDetails?.location || 'unknown'}`,
    vehicle ? `Vehicle: ${vehicle.make} ${vehicle.model} ${vehicle.year} (${vehicle.licensePlate})` : '',
    `Vehicles involved: ${claim.vehiclesInvolved?.length || 0}`,
    `Drivers: ${claim.drivers?.length || 0}`,
    `Witnesses: ${claim.witnesses?.length || 0}`,
  ].filter(Boolean).join('\n');

  const userMessage = `STRUCTURED DATA:\n${context}\n\nCLAIM NARRATIVE:\n${narrative}`;

  try {
    const tracker = new CostTracker(FEATURES.NARRATIVE_ANALYSIS);
    const resp = await complete({
      model: FAST_MODEL,
      maxTokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      meta: { feature: FEATURES.NARRATIVE_ANALYSIS, stage: 'fraud', claimId: claim._id, customerId: claim.customerId, company: claim.company },
    });
    tracker.record(resp);
    tracker.flush();

    const text = resp.content?.[0]?.text?.trim() || '{"signals":[]}';
    let parsed;
    try {
      // Extract JSON even if the model adds surrounding text
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch {
      logger.warn('[narrativeAnalysis] JSON parse failed — returning empty signals');
      parsed = { signals: [] };
    }

    const signals = (parsed.signals || []).map(s => ({
      type: s.type,
      severity: s.severity || 'medium',
      explanation: s.explanation || '',
      source: 'narrative',
    }));

    const tokensUsed = (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0);
    const kesSpent = estimateKes(FAST_MODEL, resp.usage || {});

    return { signals, tokensUsed, kesSpent };
  } catch (err) {
    logger.warn(`[narrativeAnalysis] Claude call failed: ${err.message}`);
    return { signals: [], tokensUsed: 0, kesSpent: 0 };
  }
};

module.exports = { run };
