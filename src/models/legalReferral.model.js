const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const { Schema } = mongoose;

/**
 * A request to take an existing claim into Legal.
 *
 * This is the route the specification (§5) puts first and the one the module
 * previously lacked: a claims officer working an ordinary motor claim decides it
 * needs Legal — the insured is disputing liability, a repudiation is being
 * challenged, an advocate has written in — and raises a referral from the claim.
 *
 * It is a REQUEST, not an instruction. Legal accepts or returns it. That matters
 * because the alternative — letting any claims officer create legal matters
 * directly — produces a legal register full of things that are not legal
 * matters, and a legal team that stops trusting its own inbox.
 *
 * Deliberately distinct from a third-party claim: registering a claimant IS the
 * legal matter and needs no referral. A referral is for everything else.
 */

/**
 * The specification's referral form. Everything here except the last block is
 * copied from the claim at referral time rather than typed — the officer
 * supplies judgement, not data entry, which is the difference between a referral
 * process people use and one they route around.
 */
const snapshotSchema = new Schema(
  {
    policyNumber: { type: String },
    insuredName: { type: String },
    claimantName: { type: String },
    vehicleRegistration: { type: String },
    accidentDate: { type: Date },
    accidentLocation: { type: String },
    claimStatus: { type: String },
    claimAmountMinor: { type: Number },
    reserveMinor: { type: Number },
    paidMinor: { type: Number },
    // Which supporting material already exists on the file, so Legal can see at
    // a glance what they are working with before opening anything.
    hasAssessmentReport: { type: Boolean, default: false },
    hasInvestigationReport: { type: Boolean, default: false },
    hasPoliceReport: { type: Boolean, default: false },
    photoCount: { type: Number, default: 0 },
    fraudSuspected: { type: Boolean, default: false },
    fraudRiskLevel: { type: String },
    capturedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const legalReferralSchema = new Schema(
  {
    reference: { type: String, unique: true, sparse: true },

    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },

    /**
     * Why this needs Legal. The list mirrors the specification's triggers so a
     * referral raised by hand and one raised automatically are the same kind of
     * record and appear in the same queue.
     */
    reason: {
      type: String,
      enum: [
        'third_party_demand', 'notice_of_intention_to_sue', 'summons_received', 'plaint_received',
        'serious_bodily_injury', 'fatal_accident', 'claim_above_threshold',
        'liability_disputed', 'coverage_disputed', 'repudiation_challenged',
        'insured_disputes_liability', 'claimant_rejected_offer',
        'claimant_represented', 'multiple_claimants', 'fraud_investigation',
        'police_prosecution', 'recovery_dispute', 'complaint_escalated',
        'legal_opinion_requested', 'other',
      ],
      required: true,
    },
    legalIssue: { type: String, required: true },
    urgency: { type: String, enum: ['low', 'normal', 'high'], default: 'normal', index: true },
    recommendedAction: { type: String },
    externalCounselRequired: { type: Boolean, default: false },
    notes: { type: String },

    snapshot: { type: snapshotSchema },

    /**
     * How it arrived. An automatic referral carries the trigger that fired, so a
     * tenant can see which of their rules are actually earning their place and
     * which are only generating noise.
     */
    source: {
      type: String,
      enum: ['manual', 'automatic', 'risk_engine'],
      default: 'manual',
      index: true,
    },
    trigger: { type: String },
    triggerDetail: { type: String },
    riskScore: { type: Number },
    riskLevel: { type: String },

    status: {
      type: String,
      enum: ['pending', 'accepted', 'returned', 'withdrawn'],
      default: 'pending',
      index: true,
    },

    raisedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    raisedByName: { type: String },
    raisedAt: { type: Date, default: Date.now },

    decidedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    decidedByName: { type: String },
    decidedAt: { type: Date },
    decisionNotes: { type: String },

    // What accepting it produced, so the referral remains the audit link between
    // "someone noticed" and "a legal matter exists".
    thirdPartyClaim: { type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim' },
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase' },
  },
  { timestamps: true }
);

// The referral queue: what is waiting on Legal, most urgent and oldest first.
legalReferralSchema.index({ company: 1, status: 1, urgency: -1, raisedAt: 1 });
// "Has this claim already been referred?" — checked before raising another.
legalReferralSchema.index({ claim: 1, status: 1 });
// Which automatic triggers are firing, for tuning them.
legalReferralSchema.index({ company: 1, source: 1, trigger: 1 });

legalReferralSchema.plugin(softDelete);

module.exports = mongoose.model('LegalReferral', legalReferralSchema);
