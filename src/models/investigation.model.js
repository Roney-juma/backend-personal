const mongoose = require('mongoose');
const { Schema } = mongoose;

const investigationSchema = new Schema({
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },

  // Tenant owner — copied from the flagged claim at creation so listings can be
  // scoped without joining through the claim.
  company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },

  // Set on fraud flag (Step 1)
  flaggedBy: {
    type: Schema.Types.ObjectId,
    required: function () { return this.flaggedByType !== 'system'; },
  },
  flaggedByType: { type: String, enum: ['admin', 'insuranceCompany', 'system'], required: true },
  reason: { type: String, required: true },

  // Set on investigator appointment (Step 2)
  investigatorId: { type: Schema.Types.ObjectId, ref: 'Investigator', default: null },
  appointedAt: { type: Date },

  status: {
    type: String,
    enum: ['Pending', 'Appointed', 'In Progress', 'Submitted', 'Reviewed'],
    default: 'Pending',
  },

  // Snapshotted from the claim at flagging time so the investigator has full context
  supportingDocuments: {
    photos: [String],
    videos: [String],
    repairEstimates: [String],
    medicalReports: [String],
  },
  assessmentReport: { type: Object },

  // Submitted by the investigator via the secure link
  report: {
    findings: {
      claimantInfo: { type: String },
      policeReport: { type: String },
      sceneOfAccident: { type: String },
      witnesses: { type: String },
      remarks: { type: String },
    },
    conclusion: {
      type: String,
      enum: ['Fraud Confirmed', 'Fraud Not Found', 'Inconclusive'],
    },
    evidence: [String],
    comprehensiveReport: { type: String },
    submittedAt: { type: Date },
  },

  // Admin final decision
  accessToken: { type: String, unique: true, sparse: true },
  tokenUsed: { type: Boolean, default: false },
  reviewNotes: { type: String },
  reviewedAt: { type: Date },
  reviewedBy: { type: Schema.Types.ObjectId },
}, { timestamps: true });

module.exports = mongoose.model('Investigation', investigationSchema);
