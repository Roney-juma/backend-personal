/**
 * Vehicle continuity comparator.
 *
 * Compares a downstream stage (assessment / garage / re-assessment) against the
 * claimant's baseline to answer one question: is this the SAME vehicle the
 * claimant reported? Deterministic identity checks (VIN, plate) run first and
 * short-circuit; a vision fingerprint is only extracted when needed.
 *
 * NB: we verify IDENTITY continuity, not damage sameness — damage is expected to
 * change across stages (damaged → repaired), so damage is not treated as a
 * mismatch here.
 *
 * @returns { signals, checksRun, verdict, tokensUsed, kesSpent }
 */
const { normalizeStage } = require('./stageAdapter');
const { extractFingerprint } = require('./vehicleIdentity');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const differ = (a, b) => norm(a) && norm(b) && norm(a) !== norm(b);
const match = (a, b) => norm(a) && norm(b) && norm(a) === norm(b);

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

function deriveVerdict(signals, identityConfirmed, hadVehicle) {
  const has = (prefix) => signals.some((s) => s.type.startsWith(prefix));
  if (has('vin_mismatch') || has('plate_mismatch')) return { sameVehicle: 'no', confidence: 'high' };
  if (has('vehicle_mismatch')) {
    const high = signals.some((s) => s.type.startsWith('vehicle_mismatch') && s.severity === 'high');
    return { sameVehicle: high ? 'no' : 'unclear', confidence: high ? 'medium' : 'low' };
  }
  if (identityConfirmed) return { sameVehicle: 'yes', confidence: 'high' };
  if (has('identity_unverifiable')) return { sameVehicle: 'unclear', confidence: 'low' };
  if (hadVehicle) return { sameVehicle: 'likely', confidence: 'medium' };
  return { sameVehicle: 'unclear', confidence: 'low' };
}

async function run(claim, stage) {
  const signals = [];
  const checksRun = [];
  let tokensUsed = 0;
  let kesSpent = 0;

  const base = normalizeStage(claim, 'claimant');
  const target = normalizeStage(claim, stage);
  const evidence = { stage, baseline: { plate: base.plate, vin: base.vin, make: base.make, model: base.model }, target: {} };
  let identityConfirmed = false;

  // ── 1. VIN (deterministic, highest confidence) ───────────────────────────
  if (base.vin && target.vin) {
    checksRun.push('vin_check');
    evidence.target.vin = target.vin;
    if (differ(base.vin, target.vin)) {
      signals.push(sig('vin_mismatch', 'high', target,
        `The ${target.label} VIN (${target.vin}) does not match the claimant's VIN (${base.vin}).`));
    } else {
      identityConfirmed = true;
    }
  }

  // If the mismatch is already proven by VIN, don't spend a vision call.
  const vinProvenMismatch = signals.some((s) => s.type === 'vin_mismatch');

  // ── 2. No photos on the stage → cannot visually verify ───────────────────
  if (!target.photos.length) {
    checksRun.push('photo_presence');
    if (!identityConfirmed && !vinProvenMismatch) {
      signals.push(sig('identity_unverifiable', 'low', target,
        `The ${target.label} has no photos, so the vehicle could not be visually verified.`));
    }
    const verdict = { ...deriveVerdict(signals, identityConfirmed, false), evidence };
    return { signals, checksRun, verdict, tokensUsed, kesSpent };
  }

  if (vinProvenMismatch) {
    const verdict = { ...deriveVerdict(signals, identityConfirmed, true), evidence };
    return { signals, checksRun, verdict, tokensUsed, kesSpent };
  }

  // ── 3. Vision fingerprint of the stage photos ────────────────────────────
  checksRun.push('vehicle_fingerprint');
  const fp = await extractFingerprint(target.photos, target.label);
  if (fp) { tokensUsed += fp._tokens || 0; kesSpent += fp._kes || 0; }

  if (!fp || !fp.vehicleVisible) {
    signals.push(sig('identity_unverifiable', 'medium', target,
      `Could not identify a vehicle in the ${target.label} photos.`));
    const verdict = { ...deriveVerdict(signals, identityConfirmed, false), evidence };
    return { signals, checksRun, verdict, tokensUsed, kesSpent };
  }
  evidence.target.fingerprint = publicFp(fp);
  evidence.target.plate = fp.plate;

  // ── 4. Plate: photo read vs the claimant's registered plate ──────────────
  if (fp.plate && fp.plateConfidence !== 'none') {
    checksRun.push('plate_check');
    if (differ(base.plate, fp.plate)) {
      signals.push(sig('plate_mismatch', 'high', target,
        `The number plate in the ${target.label} reads "${fp.plate}", but the claim is registered to "${base.plate}".`));
    } else if (match(base.plate, fp.plate)) {
      identityConfirmed = true;
    }
  }

  // ── 5. Make / model vs the claimant's registered vehicle ─────────────────
  const discrepancies = [];
  if (differ(base.make, fp.make)) discrepancies.push(`make (registered "${base.make}", seen "${fp.make}")`);
  if (differ(base.model, fp.model)) discrepancies.push(`model (registered "${base.model}", seen "${fp.model}")`);
  if (discrepancies.length) {
    checksRun.push('makemodel_check');
    signals.push(sig(`vehicle_mismatch_${stage}`, discrepancies.length >= 2 ? 'high' : 'medium', target,
      `The vehicle in the ${target.label} differs from the registered vehicle: ${discrepancies.join('; ')}.`));
  }

  const verdict = { ...deriveVerdict(signals, identityConfirmed, true), evidence };
  return { signals, checksRun, verdict, tokensUsed, kesSpent };
}

module.exports = { run };
