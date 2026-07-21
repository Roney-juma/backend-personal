const mongoose = require('mongoose');
const { Schema } = mongoose;

const signalSchema = new Schema({
  type: { type: String, required: true },
  severity: { type: String, enum: ['low', 'medium', 'high'], required: true },
  value: { type: Schema.Types.Mixed },
  evidence: { type: String },
  explanation: { type: String },
  source: { type: String }, // 'image_forensics' | 'data_forensics' | 'narrative' | 'vehicle_continuity'
}, { _id: false });

const aiAnalysisSchema = new Schema({
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },
  // Tenant the analysis belongs to, copied from claim.company at creation time.
  company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },
  // Legacy field — old documents hold the claim's customerId here by mistake.
  companyId: { type: Schema.Types.ObjectId },
  // 'fraud' = the filing-time pipeline (default); 'vehicle_continuity' = a
  // cross-stage same-vehicle check tied to a specific lifecycle `stage`.
  kind: { type: String, enum: ['fraud', 'vehicle_continuity'], default: 'fraud' },
  stage: { type: String }, // 'assessment' | 'garage' | 'reassessment' (continuity only)
  verdict: { type: Object }, // { sameVehicle, confidence, evidence } (continuity only)
  signals: [signalSchema],
  score: { type: Number, required: true },
  band: { type: String, enum: ['low', 'medium', 'high'], required: true },
  reasoning: { type: String },
  checksRun: [{ type: String }],
  modelVersions: { type: Object },
  tokensUsed: { type: Number, default: 0 },
  kesSpent: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('AiAnalysis', aiAnalysisSchema);
