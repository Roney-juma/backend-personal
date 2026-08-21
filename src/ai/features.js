/**
 * Canonical registry of AI features and the user-facing "actions" they roll up to.
 *
 * `feature` is the slug every model call stamps on its AiUsage row (the ledger
 * key). An `action` is the claim-lifecycle step a human recognises on a cost
 * breakdown ("Photo validation", "Claimant vs assessment"). They are not 1:1 —
 * a continuity check spends through vehicle-fingerprint AND fraud-reasoning, so
 * cost reports fold feature rows into actions via actionFor().
 *
 * Adding a new AI call site: add its slug to FEATURES, pass it in the call's
 * `meta.feature`, and map it in actionFor(). Anything unmapped still appears on
 * reports, grouped under "Other AI usage" — spend is never silently dropped.
 */

const FEATURES = {
  CLAIM_INTAKE: 'claim-intake',
  PHOTO_VALIDATE: 'photo-validate',
  NARRATIVE_ANALYSIS: 'narrative-analysis',
  FRAUD_REASONING: 'fraud-reasoning',
  VEHICLE_FINGERPRINT: 'vehicle-fingerprint',
  STAFF_ASSISTANT: 'staff-assistant',
  LEGAL_ASSISTANT: 'legal-assistant',
};

// Continuity comparisons are stage-scoped: the same features billed at a
// downstream stage belong to that stage's "claimant vs X" action.
const CONTINUITY_STAGE_LABELS = {
  assessment: 'Claimant vs assessment',
  garage: 'Claimant vs garage',
  reassessment: 'Claimant vs re-assessment',
};

/**
 * Map one ledger row (feature + stage) to its display action.
 * @returns {{ action: string, label: string }}
 */
function actionFor(feature, stage) {
  if (
    CONTINUITY_STAGE_LABELS[stage] &&
    (feature === FEATURES.VEHICLE_FINGERPRINT || feature === FEATURES.FRAUD_REASONING)
  ) {
    return { action: `claimant-vs-${stage}`, label: CONTINUITY_STAGE_LABELS[stage] };
  }
  switch (feature) {
    case FEATURES.CLAIM_INTAKE:
      return { action: 'ai-intake-agent', label: 'AI intake agent' };
    case FEATURES.PHOTO_VALIDATE:
      return { action: 'photo-validation', label: 'Photo validation' };
    case FEATURES.NARRATIVE_ANALYSIS:
    case FEATURES.FRAUD_REASONING:
      return { action: 'fraud-score-check', label: 'Fraud score check' };
    case FEATURES.VEHICLE_FINGERPRINT:
      // Fingerprint spend outside a known continuity stage (shouldn't normally happen)
      return { action: 'vehicle-identification', label: 'Vehicle identification' };
    case FEATURES.STAFF_ASSISTANT:
      return { action: 'staff-assistant', label: 'Staff assistant' };
    case FEATURES.LEGAL_ASSISTANT:
      return { action: 'legal-assistant', label: 'Legal assistant' };
    default:
      return { action: 'other', label: 'Other AI usage' };
  }
}

module.exports = { FEATURES, actionFor };
