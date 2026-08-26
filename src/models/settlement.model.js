const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const { Schema } = mongoose;

/**
 * A proposed settlement of one third-party claim.
 *
 * Its own collection rather than a sub-document on ThirdPartyClaim, for two
 * reasons: the approval queue is a cross-claim view ("what is waiting on me?"),
 * and an ApprovalRequest points at a stable subjectId. A settlement also
 * outlives several revisions of its own amount, so it needs its own history.
 *
 * The negotiation itself lives in `offers[]` — an append-only record of who
 * moved and to what. Overwriting a single `amount` field would lose the shape
 * of the negotiation, which is exactly what tells you whether the next round is
 * worth having.
 */

/**
 * One move in the negotiation. Never edited: a superseded offer is part of the
 * history of how the parties got where they are.
 */
const offerSchema = new Schema(
  {
    by: { type: String, enum: ['insurer', 'claimant'], required: true },
    amountMinor: { type: Number, required: true, min: 0 },
    at: { type: Date, default: Date.now },
    // Only set for our own offers — we do not have a user id for the other side.
    madeBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    madeByName: { type: String },
    notes: { type: String },
    // A claimant's offer can arrive by letter, phone or through their advocate.
    channel: { type: String, enum: ['letter', 'email', 'phone', 'meeting', 'advocate', 'mediation', 'other'] },
    withoutPrejudice: { type: Boolean, default: true },
  },
  { _id: true }
);

const settlementSchema = new Schema(
  {
    reference: { type: String, unique: true, sparse: true },

    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },
    thirdPartyClaim: {
      type: Schema.Types.ObjectId,
      ref: 'ThirdPartyClaim',
      required: true,
      index: true,
    },
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },

    // ── The negotiation ──────────────────────────────────────────────────────
    offers: { type: [offerSchema], default: [] },

    /**
     * The figure currently on the table from our side — the one the authority
     * matrix is applied to. Derived from the latest insurer offer.
     */
    proposedMinor: { type: Number, required: true, min: 0 },

    /**
     * Costs are settled separately from damages often enough that lumping them
     * together hides what was actually conceded.
     */
    claimantCostsMinor: { type: Number, default: 0, min: 0 },
    interestMinor: { type: Number, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'KES', uppercase: true },

    // Context captured at proposal time, so the approver sees what the proposer
    // saw without having to reconstruct it.
    exposureAtProposalMinor: { type: Number },
    reserveAtProposalMinor: { type: Number },
    demandedMinor: { type: Number },

    /**
     * status runs:
     *   draft → pending_approval → approved → accepted → executed → paid
     * with rejected / withdrawn / lapsed as terminal branches.
     *
     * `approved` means WE may offer it. `accepted` means the claimant took it.
     * Collapsing the two loses the ability to say "authorised but not agreed",
     * which is most of the life of a live negotiation.
     */
    status: {
      type: String,
      enum: [
        'draft', 'pending_approval', 'approved', 'rejected',
        'accepted', 'declined_by_claimant', 'executed', 'paid',
        'withdrawn', 'lapsed',
      ],
      default: 'draft',
      index: true,
    },

    approvalRequest: { type: Schema.Types.ObjectId, ref: 'ApprovalRequest' },

    proposedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    proposedByName: { type: String },
    proposedAt: { type: Date, default: Date.now },
    rationale: { type: String },

    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    /**
     * The amount that was actually authorised.
     *
     * Kept separately from `proposedMinor` because a settlement can be revised
     * upward after approval, and an authority given for one figure must not
     * silently carry to a larger one. The service re-seeks approval when this
     * is exceeded.
     */
    approvedAmountMinor: { type: Number },
    rejectedAt: { type: Date },
    rejectionReason: { type: String },

    acceptedAt: { type: Date },
    acceptedVia: { type: String },

    // ── Execution ────────────────────────────────────────────────────────────
    /**
     * The signed discharge voucher — the claimant's acknowledgement that the
     * payment settles the claim in full. Paying without one leaves the claim
     * technically open, so the tenant config can require it before payment.
     */
    dischargeVoucher: {
      documentId: { type: Schema.Types.ObjectId, ref: 'LegalDocument' },
      signedAt: { type: Date },
      receivedAt: { type: Date },
      reference: { type: String },
    },
    consentJudgment: { type: Boolean, default: false },

    executedAt: { type: Date },
    executedBy: { type: Schema.Types.ObjectId, ref: 'Users' },

    // ── Payment ──────────────────────────────────────────────────────────────
    paymentRequestedAt: { type: Date },
    paymentRequestedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    paidAt: { type: Date },
    paidBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    paymentMethod: { type: String },
    paymentReference: { type: String },
    payee: {
      name: { type: String },
      // Settlement money frequently goes to the claimant's advocate rather than
      // the claimant, which matters for both the audit trail and the discharge.
      type: { type: String, enum: ['claimant', 'advocate', 'court', 'other'] },
      bankName: { type: String },
      accountNumber: { type: String },
    },

    withdrawnAt: { type: Date },
    withdrawalReason: { type: String },
  },
  { timestamps: true }
);

// The approval queue and the settlement report both run on this.
settlementSchema.index({ company: 1, status: 1, proposedAt: -1 });
// "Is there already a live settlement on this exposure?"
settlementSchema.index({ thirdPartyClaim: 1, status: 1 });

settlementSchema.plugin(softDelete);

module.exports = mongoose.model('Settlement', settlementSchema);
