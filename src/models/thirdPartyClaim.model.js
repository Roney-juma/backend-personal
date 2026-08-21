const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const {
  TP_CLAIM_TYPES,
  TP_PARTY_ROLES,
  TP_CLAIM_STATUS,
  RISK_BANDS,
} = require('../constants/legal.constants');

const { Schema } = mongoose;

/**
 * A ThirdPartyClaim is ONE person's claim against our insured — the spine of the
 * Legal module.
 *
 * This is not the insured's claim. AVICS's `Claim` document records the accident
 * and the insured's own damage; this records a stranger the insured's vehicle
 * injured or whose property it damaged. One accident routinely produces several:
 * a driver, two passengers and a shopfront are four exposures on one claim, each
 * with its own fault share, its own value, its own reserve and its own clock.
 *
 * It exists from the moment a demand or injury is known — NOT from the moment a
 * suit is filed. Most third-party claims settle without litigation, so if the
 * claimant only appeared once a LegalCase existed, the insurer would have no
 * register of its largest liability until it was already in court.
 */

// ── Party ────────────────────────────────────────────────────────────────────

const partySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    idNumber: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String },
    dateOfBirth: { type: Date },
    occupation: { type: String },
    role: { type: String, enum: TP_PARTY_ROLES, required: true },

    // An employee or family member of the insured can change what the policy
    // answers for, so it is captured explicitly rather than inferred later.
    relationshipToInsured: {
      type: String,
      enum: ['none', 'employee', 'family', 'passenger_in_insured_vehicle', 'other'],
      default: 'none',
    },
  },
  { _id: false }
);

/**
 * The claimant's advocate — the opposition.
 *
 * Deliberately a plain sub-document and NOT a reference to the Advocate model.
 * Advocate records are our own panel: they hold accounts, log into the partner
 * portal and see instructions. Opposing counsel must never be able to do any of
 * that, so conflating the two is how an opposing firm ends up holding a login.
 */
const opposingAdvocateSchema = new Schema(
  {
    name: { type: String, trim: true },
    firm: { type: String, trim: true },
    lskNumber: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String },
    theirReference: { type: String },
  },
  { _id: false }
);

// ── Injury ───────────────────────────────────────────────────────────────────

const injurySchema = new Schema(
  {
    description: { type: String },
    // Matches a `reservingSchedule` code in the tenant's LegalConfig, which is
    // what seeds the reserve.
    injuryCode: { type: String },
    severity: { type: String, enum: ['minor', 'moderate', 'serious', 'severe', 'fatal'] },
    hospital: { type: String },
    admittedAt: { type: Date },
    dischargedAt: { type: Date },
    disabilityPercent: { type: Number, min: 0, max: 100 },
    deceased: { type: Boolean, default: false },
    dateOfDeath: { type: Date },
    medicalReports: [{ type: String }],
  },
  { _id: false }
);

// ── Liability ────────────────────────────────────────────────────────────────

/**
 * How the fault splits. One of the two numbers that drives every downstream
 * figure, so it is a structured, permissioned, audited field rather than a note.
 *
 * `insuredSharePercent` is what we pay on. `contributoryPercent` is the
 * claimant's own share, which reduces it.
 */
const liabilitySchema = new Schema(
  {
    insuredSharePercent: { type: Number, min: 0, max: 100 },
    contributoryPercent: { type: Number, min: 0, max: 100, default: 0 },
    otherPartiesPercent: { type: Number, min: 0, max: 100, default: 0 },
    disputed: { type: Boolean, default: false },
    basis: { type: String },
    evidence: [{ type: String }],
    assessedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    assessedAt: { type: Date },
  },
  { _id: false }
);

// ── Quantum ──────────────────────────────────────────────────────────────────

/**
 * What the claim is worth, broken down. The second number driving everything
 * downstream. All amounts are integer minor units (see utils/money.js).
 *
 * `demandedMinor` is what they are asking for; `ourAssessmentMinor` is what we
 * think it is worth. The gap between them is the negotiation.
 */
const quantumSchema = new Schema(
  {
    generalDamagesMinor: { type: Number, min: 0 },
    specialDamagesMinor: { type: Number, min: 0 },
    lossOfEarningsMinor: { type: Number, min: 0 },
    futureMedicalMinor: { type: Number, min: 0 },
    // Fatal claims: dependency and funeral heads.
    dependencyMinor: { type: Number, min: 0 },
    funeralExpensesMinor: { type: Number, min: 0 },
    claimantCostsMinor: { type: Number, min: 0 },

    demandedMinor: { type: Number, min: 0 },
    ourAssessmentMinor: { type: Number, min: 0 },

    basis: { type: String },
    comparables: [{ type: String }],
    assessedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    assessedAt: { type: Date },
  },
  { _id: false }
);

// ── Exposure (derived) ───────────────────────────────────────────────────────

/**
 * Computed, never typed: quantum → apportioned by liability → capped at the
 * policy limit. Recomputed whenever liability, quantum or the policy changes.
 *
 * `excessOfLimitMinor` is the part of the claim the policy does NOT answer for.
 * It is the insured's own exposure, and surfacing it early is one of the more
 * valuable things this module does.
 */
const exposureSchema = new Schema(
  {
    grossMinor: { type: Number, default: 0 },
    afterApportionmentMinor: { type: Number, default: 0 },
    cappedMinor: { type: Number, default: 0 },
    limitApplied: { type: Boolean, default: false },
    excessOfLimitMinor: { type: Number, default: 0 },
    computedAt: { type: Date },
  },
  { _id: false }
);

// ── Limitation ───────────────────────────────────────────────────────────────

/**
 * The statutory clock. Generated automatically on registration from the tenant's
 * configured period for this claim type, and mirrored into a LegalEvent so it
 * rides the same reminder and escalation machinery as every other deadline.
 */
const limitationSchema = new Schema(
  {
    accrualDate: { type: Date },
    periodMonths: { type: Number },
    expiresAt: { type: Date, index: true },
    basis: { type: String },
    // Acknowledgement or part-payment can restart or extend the clock.
    extendedTo: { type: Date },
    extensionReason: { type: String },
    // The LegalEvent carrying the reminders for this date.
    eventId: { type: Schema.Types.ObjectId, ref: 'LegalEvent' },
    suitFiledInTime: { type: Boolean },
  },
  { _id: false }
);

// ── Reserve ──────────────────────────────────────────────────────────────────

/**
 * Current reserve, seeded from the tenant's reserving schedule for this injury
 * type. Every change posts a ledger entry — this block is the cached head of
 * that history, not the source of truth.
 */
const reserveSchema = new Schema(
  {
    currentMinor: { type: Number, default: 0, min: 0 },
    scheduleCode: { type: String },
    seededFromMinor: { type: Number },
    overridden: { type: Boolean, default: false },
    overrideReason: { type: String },
    lastChangedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    lastChangedAt: { type: Date },
  },
  { _id: false }
);

// ── Root ─────────────────────────────────────────────────────────────────────

const thirdPartyClaimSchema = new Schema(
  {
    referenceNumber: { type: String, unique: true, sparse: true },

    // The accident. Always present: a demand naming a registration with no claim
    // on file creates a Claim stamped `source: 'third_party_notification'` first.
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },

    // Tenant owner, stamped server-side from the claim. Never trusted from the body.
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },

    // The cover that answers this claim, resolved at registration by policy
    // number or by vehicle registration + accident date.
    policyNumber: { type: String, trim: true },

    claimType: { type: String, enum: Object.values(TP_CLAIM_TYPES), required: true, index: true },

    party: { type: partySchema, required: true },
    opposingAdvocate: { type: opposingAdvocateSchema },

    injury: { type: injurySchema },
    propertyDamage: {
      description: { type: String },
      itemsDamaged: [{ type: String }],
      repairEstimateMinor: { type: Number, min: 0 },
      photos: [{ type: String }],
    },

    liability: { type: liabilitySchema, default: () => ({}) },
    quantum: { type: quantumSchema, default: () => ({}) },
    exposure: { type: exposureSchema, default: () => ({}) },
    limitation: { type: limitationSchema, default: () => ({}) },
    reserve: { type: reserveSchema, default: () => ({}) },

    status: { type: String, enum: TP_CLAIM_STATUS, default: 'notified', index: true },

    // Severity of exposure — NOT a fraud score. Drives referral and prioritisation.
    riskScore: { type: Number, default: 0 },
    riskLevel: { type: String, enum: RISK_BANDS, default: 'low' },
    riskFlags: [
      {
        code: { type: String },
        label: { type: String },
        score: { type: Number },
        detectedAt: { type: Date, default: Date.now },
      },
    ],

    // Set only once a suit is filed. Several exposures can share one case when
    // the claimants sue on a single plaint.
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },

    // How we learned about this claimant.
    source: {
      type: String,
      enum: ['insured_report', 'third_party_demand', 'advocate_demand', 'police_report', 'summons', 'other'],
      default: 'insured_report',
    },

    firstNotifiedAt: { type: Date, default: Date.now },
    demandReceivedAt: { type: Date },
    demandDocuments: [{ type: String }],

    settledAt: { type: Date },
    settledAmountMinor: { type: Number, min: 0 },
    closedAt: { type: Date },
    outcome: {
      type: String,
      enum: ['settled', 'judgment_for_claimant', 'judgment_for_insurer', 'withdrawn', 'time_barred', 'written_off'],
    },
    closureNotes: { type: String },

    registeredBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    handler: { type: Schema.Types.ObjectId, ref: 'Users', index: true },
  },
  { timestamps: true }
);

// The time-bar sweep — the single most important scheduled query in the module.
thirdPartyClaimSchema.index({ company: 1, status: 1, 'limitation.expiresAt': 1 });
// Register listing, newest first, filtered by type.
thirdPartyClaimSchema.index({ company: 1, claimType: 1, createdAt: -1 });
// Exposure roll-up per accident (limit-erosion check).
thirdPartyClaimSchema.index({ claim: 1, status: 1 });
// A handler's own workload.
thirdPartyClaimSchema.index({ handler: 1, status: 1 });

thirdPartyClaimSchema.plugin(softDelete);

module.exports = mongoose.model('ThirdPartyClaim', thirdPartyClaimSchema);
