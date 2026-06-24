const mongoose = require('mongoose');
const { Schema } = mongoose;

const investigationSchema = new Schema({
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
  // Set on flag; investigatorId and appointedAt are set later when investigator is appointed
  flaggedBy: { type: Schema.Types.ObjectId, required: true },
  flaggedByType: { type: String, enum: ['admin', 'insuranceCompany'], required: true },
  reason: { type: String, required: true },
  investigatorId: { type: Schema.Types.ObjectId, ref: 'Investigator', default: null },
  appointedAt: { type: Date },
  status: {
    type: String,
    enum: ['Pending', 'Appointed', 'In Progress', 'Submitted', 'Reviewed'],
    default: 'Pending',
  },
  report: {
    findings: { type: String },
    conclusion: {
      type: String,
      enum: ['Fraud Confirmed', 'Fraud Not Found', 'Inconclusive'],
    },
    evidence: [String],
    submittedAt: { type: Date },
  },
  accessToken: { type: String, unique: true, sparse: true },
  tokenUsed: { type: Boolean, default: false },
  reviewNotes: { type: String },
  reviewedAt: { type: Date },
  reviewedBy: { type: Schema.Types.ObjectId },
}, { timestamps: true });

module.exports = mongoose.model('Investigation', investigationSchema);
