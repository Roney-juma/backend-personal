// TEMP verdict-level simulation — persists clearly-tagged [SIMULATION] records
// showing a MATCH and a MISMATCH so the frontend cards render. Safe to delete.
require('dotenv').config();
const mongoose = require('mongoose');
const Claim = require('./src/models/claim.model');
const AiAnalysis = require('./src/models/aiAnalysis.model');
const scoreEngine = require('./src/ai/scoring/scoreEngine');

const CLAIM_ID = '6a45066cf0ff35d2ec9d8b68';

async function make(claim, stage, signals, verdict, manualReason) {
  const { score, band, reasoning } = await scoreEngine.aggregate(signals, claim);
  return AiAnalysis.create({
    claimId: claim._id,
    companyId: claim.customerId,
    kind: 'vehicle_continuity',
    stage,
    signals,
    score,
    band,
    reasoning: '[SIMULATION] ' + (manualReason || reasoning),
    verdict,
    checksRun: ['vin_check', 'plate_check', 'vehicle_fingerprint', 'makemodel_check'],
    modelVersions: { simulated: true },
    tokensUsed: 0,
    kesSpent: 0,
  });
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const claim = await Claim.findById(CLAIM_ID).lean();
  const photo = (claim.supportingDocuments && claim.supportingDocuments.photos && claim.supportingDocuments.photos[0]) || undefined;

  const del = await AiAnalysis.deleteMany({ claimId: CLAIM_ID, kind: 'vehicle_continuity' });
  console.log(`cleared ${del.deletedCount} prior continuity record(s) for a clean demo\n`);

  // ── MATCH (assessment) ───────────────────────────────────────────────────
  await make(claim, 'assessment', [],
    { sameVehicle: 'yes', confidence: 'high',
      evidence: {
        baseline: { plate: 'CA 2637282', make: 'Volkswagen', model: 'Polo' },
        target: { plate: 'CA 2637282', fingerprint: { make: 'Volkswagen', model: 'Polo', colour: 'white', bodyStyle: 'hatchback' } },
      } },
    'The number plate (CA 2637282) and make/model in the assessment report match the claimant’s registered Volkswagen Polo. Same vehicle confirmed.');

  // ── MISMATCH (garage) ────────────────────────────────────────────────────
  const sigs = [
    { type: 'plate_mismatch', severity: 'high', evidence: photo, source: 'vehicle_continuity',
      explanation: 'The number plate in the garage repair report reads "CA 9981X", but the claim is registered to "CA 2637282".' },
    { type: 'vehicle_mismatch_garage', severity: 'high', evidence: photo, source: 'vehicle_continuity',
      explanation: 'The vehicle in the garage repair report differs from the registered vehicle: make (registered "Volkswagen", seen "Toyota"); model (registered "Polo", seen "Hilux").' },
  ];
  await make(claim, 'garage', sigs,
    { sameVehicle: 'no', confidence: 'high',
      evidence: {
        baseline: { plate: 'CA 2637282', make: 'Volkswagen', model: 'Polo' },
        target: { plate: 'CA 9981X', fingerprint: { make: 'Toyota', model: 'Hilux', colour: 'silver', bodyStyle: 'pickup' } },
      } });

  const recs = await AiAnalysis.find({ claimId: CLAIM_ID, kind: 'vehicle_continuity' }).sort({ createdAt: -1 }).lean();
  const latest = {};
  for (const a of recs) if (a.stage && !latest[a.stage]) latest[a.stage] = a;
  console.log(`GET /claims/continuity/${CLAIM_ID} -> ${Object.keys(latest).length} card(s):`);
  for (const a of Object.values(latest)) {
    console.log(`\n  • ${a.stage} vs claimant:  ${a.verdict.sameVehicle.toUpperCase()} (${a.verdict.confidence})  score ${a.score}/${a.band}`);
    console.log(`      ${a.reasoning}`);
    for (const s of a.signals) console.log(`      - ${s.type} (${s.severity}): ${s.explanation}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('sim2 failed:', e.message); process.exit(1); });
