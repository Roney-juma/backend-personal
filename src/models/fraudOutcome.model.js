const mongoose = require('mongoose');
const { Schema } = mongoose;

const fraudOutcomeSchema = new Schema({
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },
  analysisId: { type: Schema.Types.ObjectId, ref: 'AiAnalysis' },
  predictedBand: { type: String, enum: ['low', 'medium', 'high'] },
  actualOutcome: {
    type: String,
    enum: ['cleared', 'confirmed_fraud', 'settled', 'inconclusive'],
    required: true,
  },
  decidedBy: { type: Schema.Types.ObjectId },
  decidedAt: { type: Date, default: Date.now },
  notes: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('FraudOutcome', fraudOutcomeSchema);
