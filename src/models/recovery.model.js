const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const { Schema } = mongoose;

/**
 * Subrogation — the mirror image of a third-party claim.
 *
 * Where a ThirdPartyClaim is somebody claiming against our insured, a Recovery
 * is US claiming against somebody else: our insured was not at fault, we paid
 * our own insured, and we now go after whoever was.
 *
 * Two consequences of that inversion run through this model. First, the money
 * moves the other way — recoveries post as CREDITS to the same legal ledger, so
 * a matter's net exposure falls as recovery comes in. Second, we are the
 * plaintiff, so when a recovery is litigated the LegalCase carries
 * `matterType: 'recovery'` and the parties are reversed.
 *
 * Both sides can be live on one accident: in a shared-fault collision we pay a
 * proportion out and recover a proportion back.
 */

/**
 * Who we are recovering from. A third-party insurer is the common case and the
 * one most likely to pay; the others are progressively harder and worth
 * tracking separately so the recovery report shows where effort actually
 * converts.
 */
const recoverFromSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['third_party_insurer', 'driver', 'employer', 'manufacturer', 'garage', 'other'],
      required: true,
    },
    name: { type: String, required: true, trim: true },
    // Their insurer and policy, where the target is itself insured — this is
    // what turns a recovery from a chase into a claim.
    insurer: { type: String, trim: true },
    policyNumber: { type: String, trim: true },
    claimReference: { type: String, trim: true },
    contact: {
      phone: { type: String },
      email: { type: String },
      address: { type: String },
    },
    advocate: {
      name: { type: String },
      firm: { type: String },
      reference: { type: String },
    },
  },
  { _id: false }
);

const recoverySchema = new Schema(
  {
    reference: { type: String, unique: true, sparse: true },

    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },
    // Set when recovering an amount we paid out on a specific third-party claim.
    thirdPartyClaim: { type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim', index: true },
    // Set only if the recovery itself goes to court, with matterType 'recovery'.
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },

    recoverFrom: { type: recoverFromSchema, required: true },

    /**
     * Why they owe us. Recorded explicitly because it determines what evidence
     * the file needs and how likely the recovery is — a knock-for-knock claim
     * against another insurer is a different exercise from chasing an uninsured
     * driver personally.
     */
    basis: {
      type: String,
      enum: [
        'negligence', 'vicarious_liability', 'product_defect',
        'defective_repair', 'contractual_indemnity', 'knock_for_knock', 'fraud', 'other',
      ],
      required: true,
    },
    basisNotes: { type: String },

    // ── Money (integer minor units) ──────────────────────────────────────────
    /** What we actually paid out and are trying to get back. */
    outlayMinor: { type: Number, required: true, min: 0 },
    /**
     * What we believe is recoverable — outlay reduced by our own insured's share
     * of the fault. Recovering 100% of an outlay on a 70:30 accident is not a
     * realistic target, and recording it as one makes the recovery report lie.
     */
    recoverableMinor: { type: Number, required: true, min: 0 },
    ourInsuredSharePercent: { type: Number, min: 0, max: 100, default: 0 },

    recoveredMinor: { type: Number, default: 0, min: 0 },
    expensesMinor: { type: Number, default: 0, min: 0 },
    writtenOffMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'KES', uppercase: true },

    status: {
      type: String,
      enum: [
        'identified',      // we think there is something to recover
        'demand_sent',
        'negotiating',
        'agreed',
        'litigated',
        'part_recovered',
        'recovered',
        'written_off',
        'abandoned',
      ],
      default: 'identified',
      index: true,
    },

    // ── Chase history ────────────────────────────────────────────────────────
    identifiedAt: { type: Date, default: Date.now },
    identifiedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    demandSentAt: { type: Date },
    /**
     * Every chase, so the recovery report can show effort against result. A
     * recovery that has been chased eight times without response is telling you
     * something a status field alone does not.
     */
    chases: [
      {
        at: { type: Date, default: Date.now },
        channel: { type: String, enum: ['letter', 'email', 'phone', 'advocate', 'meeting'] },
        notes: { type: String },
        by: { type: Schema.Types.ObjectId, ref: 'Users' },
        response: { type: String },
      },
    ],
    lastChasedAt: { type: Date },

    agreedMinor: { type: Number, min: 0 },
    agreedAt: { type: Date },

    /**
     * Recoveries are time-barred like anything else — and this one is OUR clock,
     * so missing it is entirely our own doing.
     */
    limitation: {
      accrualDate: { type: Date },
      expiresAt: { type: Date, index: true },
      eventId: { type: Schema.Types.ObjectId, ref: 'LegalEvent' },
    },

    // ── Closure ──────────────────────────────────────────────────────────────
    closedAt: { type: Date },
    writeOffReason: { type: String },
    writeOffApprovedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    handler: { type: Schema.Types.ObjectId, ref: 'Users', index: true },
    notes: { type: String },
  },
  { timestamps: true }
);

// The recovery register: what is outstanding, oldest first.
recoverySchema.index({ company: 1, status: 1, identifiedAt: 1 });
// Everything being recovered on one accident.
recoverySchema.index({ claim: 1 });
// The recovery time-bar sweep.
recoverySchema.index({ company: 1, 'limitation.expiresAt': 1 });

/** Still outstanding after what has come in and what has been written off. */
recoverySchema.virtual('outstandingMinor').get(function outstanding() {
  return Math.max(0, (this.recoverableMinor || 0) - (this.recoveredMinor || 0) - (this.writtenOffMinor || 0));
});

recoverySchema.set('toJSON', { virtuals: true });
recoverySchema.set('toObject', { virtuals: true });

recoverySchema.plugin(softDelete);

module.exports = mongoose.model('Recovery', recoverySchema);
