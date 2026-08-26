const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { MATTER_TYPES, LEGAL_CASE_STATUS, RISK_BANDS } = require('../constants/legal.constants');

const { Schema } = mongoose;

/**
 * A LegalCase is ONE court file.
 *
 * It is created when a suit is filed — not when a claimant appears. Most
 * third-party claims settle without one; see ThirdPartyClaim, which is the
 * entity that exists from first notification.
 *
 * One case can cover several third-party claimants: three passengers suing on a
 * single plaint is one case and three exposures. Money and quantum live on the
 * exposures; the court file, the diary, the pleadings and our advocate live here.
 */

/**
 * The policy as it stood at the accident — frozen, not looked up live.
 *
 * A policy is renewed, endorsed and amended over the years a matter runs. What
 * matters in court is the cover in force on the day of the accident, so it is
 * snapshotted at referral and never refreshed.
 */
const coverSnapshotSchema = new Schema(
  {
    policyNumber: { type: String },
    policyType: { type: String },
    status: { type: String },
    startDate: { type: Date },
    expiryDate: { type: Date },
    liabilityLimits: {
      propertyDamageMinor: { type: Number },
      bodilyInjuryMinor: { type: Number },
      aggregateMinor: { type: Number },
    },
    excessMinor: { type: Number },
    exclusions: [{ type: String }],
    endorsements: [{ type: String }],
    relevantClauses: [{ type: String }],
    snapshotAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Judgment is one-per-case, so it embeds. An appeal creates a child case with
 * its own judgment rather than a second judgment here.
 */
const judgmentSchema = new Schema(
  {
    deliveredAt: { type: Date },
    awardMinor: { type: Number, min: 0 },
    interestMinor: { type: Number, min: 0 },
    costsMinor: { type: Number, min: 0 },
    totalMinor: { type: Number, min: 0 },
    interestRatePercent: { type: Number },
    interestFrom: { type: Date },
    liabilityOutcome: {
      type: String,
      enum: ['for_claimant', 'for_insurer', 'apportioned', 'dismissed', 'struck_out'],
    },
    apportionmentPercent: { type: Number, min: 0, max: 100 },
    summary: { type: String },
    documents: [{ type: String }],
    satisfiedAt: { type: Date },
    appealed: { type: Boolean, default: false },
  },
  { _id: false }
);

/**
 * Counsel's written advice. Embedded because opinions are read in the context of
 * their case and never queried across cases.
 */
const opinionSchema = new Schema(
  {
    category: {
      type: String,
      enum: ['coverage', 'liability', 'quantum', 'repudiation', 'recovery', 'fraud',
             'settlement', 'litigation_prospects', 'appeal', 'regulatory', 'contractual'],
    },
    issue: { type: String },
    relevantFacts: { type: String },
    policyProvisions: { type: String },
    applicableLaw: { type: String },
    analysis: { type: String },
    risk: { type: String, enum: ['low', 'medium', 'high'] },
    recommendation: { type: String },
    financialImplicationMinor: { type: Number },
    requiredApproval: { type: String },
    authorType: { type: String, enum: ['Advocate', 'Users'] },
    author: { type: Schema.Types.ObjectId, refPath: 'opinions.authorType' },
    documentId: { type: Schema.Types.ObjectId, ref: 'LegalDocument' },
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const legalCaseSchema = new Schema(
  {
    // Assigned on referral approval, not at referral — a rejected referral must
    // not burn a case number that has already been quoted anywhere.
    caseNumber: { type: String, unique: true, sparse: true },
    referralNumber: { type: String, index: true },

    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },

    /**
     * Not every legal matter is third-party. A coverage dispute or a challenged
     * repudiation is the insured suing us; a recovery action is us suing someone
     * else. Same court machinery, opposite side of the table — so this drives
     * who the parties are and which permissions apply.
     */
    matterType: {
      type: String,
      enum: Object.values(MATTER_TYPES),
      default: MATTER_TYPES.THIRD_PARTY_LIABILITY,
      index: true,
    },

    // The exposures this suit covers. Empty for non-third-party matters.
    thirdPartyClaims: [{ type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim' }],

    // ── Court ────────────────────────────────────────────────────────────────
    court: { type: String, trim: true },
    courtStation: { type: String, trim: true },
    courtCaseNumber: { type: String, trim: true },
    filedAt: { type: Date },
    servedAt: { type: Date },
    plaintiffs: [{ name: { type: String }, advocate: { type: String } }],
    defendants: [{ name: { type: String }, isInsured: { type: Boolean, default: false } }],

    // ── Our counsel ──────────────────────────────────────────────────────────
    advocate: { type: Schema.Types.ObjectId, ref: 'Advocate', index: true },
    appointedAt: { type: Date },
    appointedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    // How the panel member was chosen, so allocation policy can be reviewed.
    allocationMode: { type: String, enum: ['ranked', 'random', 'manual'] },
    allocationScore: { type: Number },
    instructionsIssuedAt: { type: Date },
    // Drives the progress-report chaser: an advocate who has gone quiet on a
    // live matter is the commonest way an insurer finds out about a problem late.
    lastProgressReportAt: { type: Date },
    progressReports: [{
      summary: { type: String },
      nextSteps: { type: String },
      submittedAt: { type: Date, default: Date.now },
      submittedBy: { type: Schema.Types.ObjectId, ref: 'Advocate' },
    }],
    instructionsAcceptedAt: { type: Date },
    specificInstructions: { type: String },

    coverSnapshot: { type: coverSnapshotSchema },

    status: { type: String, enum: LEGAL_CASE_STATUS, default: 'referred', index: true },

    riskRating: { type: String, enum: RISK_BANDS, default: 'low' },

    // Denormalised head of the diary so case lists can show "what's next"
    // without joining LegalEvent for every row.
    nextActionAt: { type: Date, index: true },
    nextActionLabel: { type: String },
    nextEventId: { type: Schema.Types.ObjectId, ref: 'LegalEvent' },

    /**
     * Cached roll-up of the ledger, recomputed on every posting. The ledger is
     * the source of truth; this exists so the dashboard does not aggregate
     * millions of rows on every page load.
     */
    financials: {
      reserveClaimMinor: { type: Number, default: 0 },
      reserveLegalMinor: { type: Number, default: 0 },
      reserveJudgmentMinor: { type: Number, default: 0 },
      feesToDateMinor: { type: Number, default: 0 },
      paidToDateMinor: { type: Number, default: 0 },
      recoveredToDateMinor: { type: Number, default: 0 },
      netExposureMinor: { type: Number, default: 0 },
      recomputedAt: { type: Date },
    },

    judgment: { type: judgmentSchema },
    opinions: { type: [opinionSchema], default: [] },

    // Appeals are child cases, so the original's history stays intact.
    parentCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },
    isAppeal: { type: Boolean, default: false },

    // ── Referral trail ───────────────────────────────────────────────────────
    referredBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    referredAt: { type: Date },
    referralReason: { type: String },
    referralTrigger: { type: String },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    approvedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String },

    // ── Closure (spec §8 stage 9) ────────────────────────────────────────────
    closureChecklist: {
      settlementOrJudgmentPaid: { type: Boolean, default: false },
      recoveryCompletedOrWrittenOff: { type: Boolean, default: false },
      advocateFeesSettled: { type: Boolean, default: false },
      documentsArchived: { type: Boolean, default: false },
      finalReportReceived: { type: Boolean, default: false },
      lessonsLearnedRecorded: { type: Boolean, default: false },
    },
    lessonsLearned: { type: String },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
  },
  { timestamps: true }
);

// The dashboard's primary query: open matters by what's due next.
legalCaseSchema.index({ company: 1, status: 1, nextActionAt: 1 });
// Advocate scorecard and portal listings.
legalCaseSchema.index({ advocate: 1, status: 1 });
// Court performance reporting.
legalCaseSchema.index({ company: 1, court: 1, status: 1 });

legalCaseSchema.plugin(softDelete);

module.exports = mongoose.model('LegalCase', legalCaseSchema);
