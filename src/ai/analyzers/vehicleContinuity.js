/**
 * Vehicle continuity comparator.
 *
 * Answers: is the vehicle the assessor (or garage / re-assessor) photographed the
 * SAME one the claimant reported? The comparison is PHOTO-TO-PHOTO — we extract a
 * fingerprint (make, model, colour, plate) from the claimant's picture and from
 * the stage's picture and compare them. Crucially this works even when NO number
 * plate is visible in either photo: make + colour carry the identity, and a
 * readable plate (when present) is a bonus, high-confidence confirmation.
 *
 * We verify IDENTITY continuity, not damage sameness — damage is expected to
 * change across stages (damaged → repaired).
 *
 * @returns { signals, checksRun, verdict, tokensUsed, kesSpent }
 */
const { normalizeStage } = require('./stageAdapter');
const { extractFingerprint, fingerprintCacheKey, FINGERPRINT_PROMPT_VERSION } = require('./vehicleIdentity');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const differ = (a, b) => norm(a) && norm(b) && norm(a) !== norm(b);
const match = (a, b) => norm(a) && norm(b) && norm(a) === norm(b);
// Colour is fuzzy (lighting, "dark blue" vs "blue"): only a mismatch when neither
// string contains the other.
const colourDiffer = (a, b) => {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return !(na.includes(nb) || nb.includes(na));
};
const colourMatch = (a, b) => {
  const na = norm(a), nb = norm(b);
  return !!na && !!nb && (na.includes(nb) || nb.includes(na));
};

const sig = (type, severity, target, explanation) => ({
  type,
  severity,
  evidence: (target.photos && target.photos[0]) || undefined,
  explanation,
  source: 'vehicle_continuity',
});

const publicFp = (fp) =>
  fp && {
    plate: fp.plate,
    plateConfidence: fp.plateConfidence,
    make: fp.make,
    model: fp.model,
    colour: fp.colour,
    bodyStyle: fp.bodyStyle,
    notableFeatures: fp.notableFeatures,
    visibleDamage: fp.visibleDamage,
  };

function deriveVerdict({ signals, plateConfirmed, makeOk, colourOk, makeKnown }) {
  const has = (prefix) => signals.some((s) => s.type.startsWith(prefix));
  const highMismatch = signals.some((s) => s.type.startsWith('vehicle_mismatch') && s.severity === 'high');
  const medMismatch = signals.some((s) => s.type.startsWith('vehicle_mismatch') && s.severity === 'medium');

  if (has('vin_mismatch') || has('plate_mismatch') || highMismatch) return { sameVehicle: 'no', confidence: 'high' };
  if (plateConfirmed && makeOk) return { sameVehicle: 'yes', confidence: 'high' };
  if (has('identity_unverifiable')) return { sameVehicle: 'unclear', confidence: 'low' };
  if (makeOk && colourOk) return { sameVehicle: 'yes', confidence: 'medium' }; // appearance strongly agrees
  if (medMismatch) return { sameVehicle: 'unclear', confidence: 'low' };
  if (makeOk) return { sameVehicle: 'likely', confidence: 'medium' }; // make agrees, colour unknown
  if (!makeKnown) return { sameVehicle: 'unclear', confidence: 'low' };
  return { sameVehicle: 'likely', confidence: 'low' };
}

// Reuse the claimant fingerprint stored on the claim when it was produced by the
// same prompt version over the same photo set — the vision call is deterministic
// enough that re-running it per stage only burns tokens.
function cachedBaseline(claim, photos) {
  const stored = claim && claim.ai && claim.ai.baselineFingerprint;
  if (!stored || !stored.fingerprint) return null;
  if (stored.promptVersion !== FINGERPRINT_PROMPT_VERSION) return null;
  if (stored.photosHash !== fingerprintCacheKey(photos)) return null;
  return stored.fingerprint;
}

async function run(claim, stage) {
  const signals = [];
  const checksRun = [];
  let tokensUsed = 0;
  let kesSpent = 0;
  let baselineFingerprintUpdate = null; // set when a fresh baseline should be persisted

  const base = normalizeStage(claim, 'claimant');
  const target = normalizeStage(claim, stage);
  const evidence = { stage, baseline: {}, target: {} };
  let plateConfirmed = false;

  const finish = (extra) => {
    const verdict = { ...deriveVerdict({ signals, plateConfirmed, ...extra }), evidence };
    return { signals, checksRun, verdict, tokensUsed, kesSpent, baselineFingerprintUpdate };
  };

  // ── 1. VIN (deterministic, when both typed VINs exist) ───────────────────
  if (base.vin && target.vin) {
    checksRun.push('vin_check');
    evidence.baseline.vin = base.vin;
    evidence.target.vin = target.vin;
    if (differ(base.vin, target.vin)) {
      signals.push(sig('vin_mismatch', 'high', target,
        `The ${target.label} VIN (${target.vin}) does not match the claimant's VIN (${base.vin}).`));
      return finish({ makeOk: false, colourOk: false, makeKnown: false });
    }
    plateConfirmed = true; // VIN match is as strong as a plate match
  }

  // ── 2. Need a stage photo to compare appearance ──────────────────────────
  if (!target.photos.length) {
    checksRun.push('photo_presence');
    if (!plateConfirmed) {
      signals.push(sig('identity_unverifiable', 'low', target,
        `The ${target.label} has no photos, so the vehicle could not be visually verified.`));
    }
    return finish({ makeOk: plateConfirmed, colourOk: false, makeKnown: false });
  }

  // ── 3. Photo-to-photo fingerprints: claimant picture vs stage picture ────
  checksRun.push('vehicle_fingerprint');
  const usageMeta = { claimId: claim._id, customerId: claim.customerId, company: claim.company, stage };
  let baseFp = base.photos.length ? cachedBaseline(claim, base.photos) : null;
  if (!baseFp && base.photos.length) {
    baseFp = await extractFingerprint(base.photos, 'claimant', usageMeta);
    if (baseFp) {
      baselineFingerprintUpdate = {
        promptVersion: FINGERPRINT_PROMPT_VERSION,
        photosHash: fingerprintCacheKey(base.photos),
        fingerprint: { vehicleVisible: baseFp.vehicleVisible, ...publicFp(baseFp) },
        extractedAt: new Date(),
      };
    }
  }
  const targetFp = await extractFingerprint(target.photos, target.label, usageMeta);
  for (const fp of [baseFp, targetFp]) if (fp) { tokensUsed += fp._tokens || 0; kesSpent += fp._kes || 0; }

  if (!targetFp || !targetFp.vehicleVisible) {
    signals.push(sig('identity_unverifiable', 'medium', target,
      `Could not identify a vehicle in the ${target.label} photos.`));
    return finish({ makeOk: false, colourOk: false, makeKnown: false });
  }
  evidence.target.fingerprint = publicFp(targetFp);
  if (baseFp) evidence.baseline.fingerprint = publicFp(baseFp);

  // Baseline identity: prefer what we SEE in the claimant photo, fall back to the
  // typed registration fields (which have no colour).
  const baseMake = (baseFp && baseFp.vehicleVisible && baseFp.make) || base.make;
  const baseModel = (baseFp && baseFp.vehicleVisible && baseFp.model) || base.model;
  const baseColour = (baseFp && baseFp.vehicleVisible && baseFp.colour) || '';
  const basePlate = (baseFp && baseFp.plateConfidence !== 'none' && baseFp.plate) || base.plate;
  evidence.baseline = { ...evidence.baseline, plate: basePlate || '', make: baseMake || '', model: baseModel || '', colour: baseColour || '' };
  evidence.target.plate = targetFp.plate;

  if (!baseMake && !baseColour && !basePlate) {
    signals.push(sig('identity_unverifiable', 'low', target,
      'No baseline vehicle details from the claimant to compare against.'));
    return finish({ makeOk: false, colourOk: false, makeKnown: false });
  }

  // ── 4. Plate (bonus, strong when both photos show one) ───────────────────
  if (targetFp.plate && targetFp.plateConfidence !== 'none' && basePlate) {
    checksRun.push('plate_check');
    if (differ(basePlate, targetFp.plate)) {
      signals.push(sig('plate_mismatch', 'high', target,
        `The number plate in the ${target.label} reads "${targetFp.plate}", but the claimant's is "${basePlate}".`));
    } else if (match(basePlate, targetFp.plate)) {
      plateConfirmed = true;
    }
  }

  // ── 5. Make + colour + model (the primary appearance comparison) ─────────
  checksRun.push('appearance_check');
  const makeKnown = !!(baseMake && targetFp.make);
  const makeDiff = differ(baseMake, targetFp.make);
  const modelDiff = differ(baseModel, targetFp.model);
  const colDiff = colourDiffer(baseColour, targetFp.colour);
  const makeOk = match(baseMake, targetFp.make);
  const colourOk = colourMatch(baseColour, targetFp.colour);

  const parts = [];
  if (makeDiff) parts.push(`make (claimant "${baseMake}", ${target.label} "${targetFp.make}")`);
  if (colDiff) parts.push(`colour (claimant "${baseColour}", ${target.label} "${targetFp.colour}")`);
  if (modelDiff) parts.push(`model (claimant "${baseModel}", ${target.label} "${targetFp.model}")`);

  if (makeDiff) {
    // A different manufacturer is definitive.
    signals.push(sig(`vehicle_mismatch_${stage}`, 'high', target,
      `The vehicle in the ${target.label} differs from the claimant's: ${parts.join('; ')}.`));
  } else if (colDiff || (modelDiff && !makeOk)) {
    // Colour, or a model difference when the make isn't confirmed, can be lighting
    // or trim differences — flag for review. A model-only difference when make AND
    // colour already agree is just naming variance (e.g. "Gran" vs "Grand"), so we
    // don't flag it.
    signals.push(sig(`vehicle_mismatch_${stage}`, 'medium', target,
      `Possible mismatch between the claimant's and the ${target.label} vehicle: ${parts.join('; ')}.`));
  }

  return finish({ makeOk, colourOk, makeKnown });
}

module.exports = { run };
