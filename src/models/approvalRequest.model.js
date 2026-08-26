const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const { Schema } = mongoose;

/**
 * A request for authority, routed by the tenant's settlement authority matrix.
 *
 * Deliberately generic (`subjectType` + `subjectId`) rather than a
 * settlement-specific table: settlements, payment requests and counsel
 * appointments all need the same request → decision → escalation shape, and
 * other modules can adopt it later without a second implementation.
 */

const decisionSchema = new Schema(
  {
    approver: { type: Schema.Types.ObjectId, ref: 'Users' },
    approverName: { type: String },
    approverRole: { type: String },
    decision: { type: String, enum: ['approved', 'rejected', 'escalated'], required: true },
    notes: { type: String },
    at: { type: Date, default: Date.now },
    ipAddress: { type: String },
  },
  { _id: false }
);

const approvalRequestSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },

    subjectType: {
      type: String,
      enum: ['Settlement', 'PaymentRequest', 'CounselAppointment', 'ReserveOverride', 'WriteOff'],
      required: true,
      index: true,
    },
    subjectId: { type: Schema.Types.ObjectId, required: true, index: true },

    // Context, denormalised so an approval queue renders without four joins.
    claim: { type: Schema.Types.ObjectId, ref: 'Claim' },
    thirdPartyClaim: { type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim' },
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase' },
    summary: { type: String },

    amountMinor: { type: Number, required: true },
    currency: { type: String, default: 'KES', uppercase: true },

    /**
     * The authority band that applied, copied in full at request time.
     *
     * This is the point of the whole record. Two years on, when the matrix has
     * been edited three times and a settlement is questioned, the approval must
     * prove which policy was in force on the day. A live lookup against the
     * current config cannot do that, and reconstructing it from an audit diff is
     * not something anyone should have to do under scrutiny.
     */
    matrixRuleSnapshot: {
      minMinor: { type: Number },
      maxMinor: { type: Number },
      approverKind: { type: String },
      approver: { type: String },
      configVersion: { type: Number },
      snapshotAt: { type: Date, default: Date.now },
    },

    requiredApprover: { type: String },
    requiredApproverKind: { type: String, enum: ['role', 'permission', 'user'] },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'Users', required: true },
    requestedByName: { type: String },
    requestedAt: { type: Date, default: Date.now },
    justification: { type: String },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'escalated', 'withdrawn', 'expired'],
      default: 'pending',
      index: true,
    },

    decisions: { type: [decisionSchema], default: [] },

    // Escalation up the authority matrix when a request sits unactioned. Distinct
    // from the deadline escalation chain on LegalEvent — that one wakes people
    // about dates, this one moves an amount up to someone who can sign it off.
    escalatedFrom: { type: String },
    escalatedAt: { type: Date },

    decidedAt: { type: Date },
    dueBy: { type: Date },
  },
  { timestamps: true }
);

// The approval queue: what is waiting on me, oldest first.
approvalRequestSchema.index({ company: 1, status: 1, requestedAt: 1 });
// "Has this settlement already been through approval?"
approvalRequestSchema.index({ subjectType: 1, subjectId: 1, status: 1 });

approvalRequestSchema.plugin(softDelete);

module.exports = mongoose.model('ApprovalRequest', approvalRequestSchema);
