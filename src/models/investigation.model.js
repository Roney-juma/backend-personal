const mongoose = require('mongoose');
const { Schema } = mongoose;

const investigationSchema = new Schema({
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
  investigatorId: { type: Schema.Types.ObjectId, ref: 'Investigator', required: true },
  assignedBy: { type: Schema.Types.ObjectId, required: true },
  assignedByType: { type: String, enum: ['admin', 'insuranceCompany'], required: true },
  reason: { type: String, required: true },
  status: {
    type: String,
    enum: ['Pending', 'In Progress', 'Submitted', 'Reviewed'],
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
  reviewNotes: { type: String },
  reviewedAt: { type: Date },
  reviewedBy: { type: Schema.Types.ObjectId },
}, { timestamps: true });

module.exports = mongoose.model('Investigation', investigationSchema);
