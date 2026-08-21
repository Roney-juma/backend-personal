const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const {
  DEFAULT_EVENT_TYPES,
  DEFAULT_REMINDER_OFFSETS,
  DEFAULT_LIMITATION_PERIODS,
  DEFAULT_ESCALATION_CHAIN,
  DEFAULT_AUTHORITY_MATRIX,
  DEFAULT_RESERVING_SCHEDULE,
  DEFAULT_ALLOCATION_WEIGHTS,
  DEFAULT_RISK_WEIGHTS,
  DEFAULT_RISK_THRESHOLDS,
  ALLOCATION_MODES,
} = require('../constants/legal.constants');

const { Schema } = mongoose;

/**
 * Per-tenant Legal module configuration.
 *
 * Spec §32 is explicit that the system must be configurable to each insurer's
 * approved claims procedures and authority matrix rather than hard-coding one
 * insurer's process. This document is that configuration: one per company,
 * versioned so a decision made under an older policy can still be explained.
 *
 * Read it through service/legalConfig.service.js, never directly — that service
 * caches it and falls back to the seeded defaults for a tenant who has not been
 * configured yet.
 */

// ── Settlement authority ─────────────────────────────────────────────────────

/**
 * A band in the authority matrix. `maxMinor: null` = no upper bound.
 *
 * Kept separate from the escalation chain on purpose: this decides who may SIGN
 * OFF an amount. Who gets WOKEN about a missed deadline is escalationChain.
 */
const authorityBandSchema = new Schema(
  {
    minMinor: { type: Number, required: true, min: 0 },
    maxMinor: { type: Number, default: null },
    approverKind: { type: String, enum: ['role', 'permission', 'user'], default: 'role' },
    approver: { type: String, required: true },
    label: { type: String },
  },
  { _id: false }
);

// ── Escalation ───────────────────────────────────────────────────────────────

const escalationRungSchema = new Schema(
  {
    rung: { type: Number, required: true },
    role: { type: String, required: true },
    // Days at this rung without action before the next rung is notified.
    afterDays: { type: Number, default: 3, min: 0 },
  },
  { _id: false }
);

// ── Reserving ────────────────────────────────────────────────────────────────

/**
 * The insurer's own reserving policy, by injury type. A reserve is seeded from
 * `defaultMinor` and may be overridden only with a reason and the
 * OVERRIDE_RESERVE_SCHEDULE permission — so every departure from company policy
 * is deliberate and attributable.
 */
const reservingBandSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    minMinor: { type: Number, default: 0, min: 0 },
    maxMinor: { type: Number, default: 0, min: 0 },
    defaultMinor: { type: Number, default: 0, min: 0 },
    notes: { type: String },
  },
  { _id: false }
);

// ── Diary ────────────────────────────────────────────────────────────────────

/**
 * Diary event types are tenant data, not a schema enum: legal officers add their
 * own deadline types (taxation of costs, mediation, statutory notices) and the
 * reminder ladder applies to them identically.
 */
const eventTypeSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    kind: { type: String, required: true },
    // Overrides the tenant-wide ladder for this type — a summons return date
    // usually warrants a tighter ladder than a routine mention.
    reminderOffsets: { type: [Number], default: undefined },
    escalates: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  },
  { _id: false }
);

// ── Referral triggers ────────────────────────────────────────────────────────

const referralTriggerSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String },
    enabled: { type: Boolean, default: true },
    // Trigger-specific parameters, e.g. { thresholdMinor: 100000000 }
    params: { type: Schema.Types.Mixed },
    autoRefer: { type: Boolean, default: false },
  },
  { _id: false }
);

const legalConfigSchema = new Schema(
  {
    company: {
      type: Schema.Types.ObjectId,
      ref: 'InsuranceCompany',
      required: true,
      unique: true,
      index: true,
    },

    // Bumped on every edit. Approval records snapshot the rule they applied
    // along with this version, so a decision can always be explained against
    // the policy that was in force on the day.
    version: { type: Number, default: 1 },

    // ── Money ────────────────────────────────────────────────────────────────
    currency: { type: String, default: 'KES', uppercase: true },

    // ── Settlement authority ─────────────────────────────────────────────────
    authorityMatrix: { type: [authorityBandSchema], default: () => [...DEFAULT_AUTHORITY_MATRIX] },

    // ── Escalation (deadlines) ───────────────────────────────────────────────
    escalationChain: { type: [escalationRungSchema], default: () => [...DEFAULT_ESCALATION_CHAIN] },

    // ── Statutory limitation, in MONTHS from the accrual date ────────────────
    // Keyed by third-party claim type. Jurisdiction-specific; seeded from the
    // values approved 21 Aug 2026 and editable per tenant.
    limitationPeriods: {
      type: Map,
      of: Number,
      default: () => new Map(Object.entries(DEFAULT_LIMITATION_PERIODS)),
    },

    // Warn this far ahead of a limitation date regardless of the general ladder —
    // a time-bar is not a deadline you want to learn about with 2 days left.
    limitationWarningDays: { type: [Number], default: [180, 90, 60, 30, 14, 7] },

    // ── Reserving ────────────────────────────────────────────────────────────
    reservingSchedule: { type: [reservingBandSchema], default: () => [...DEFAULT_RESERVING_SCHEDULE] },
    requireReserveOnRegistration: { type: Boolean, default: true },

    // ── Diary ────────────────────────────────────────────────────────────────
    eventTypes: { type: [eventTypeSchema], default: () => [...DEFAULT_EVENT_TYPES] },
    reminderOffsets: { type: [Number], default: () => [...DEFAULT_REMINDER_OFFSETS] },
    overdueReminderEveryDays: { type: Number, default: 3 },

    // ── Referral ─────────────────────────────────────────────────────────────
    referralTriggers: { type: [referralTriggerSchema], default: [] },

    // ── Legal risk (severity of exposure, not fraud suspicion) ───────────────
    riskWeights: {
      type: Map,
      of: Number,
      default: () => new Map(Object.entries(DEFAULT_RISK_WEIGHTS)),
    },
    riskThresholds: {
      medium:   { type: Number, default: DEFAULT_RISK_THRESHOLDS.medium },
      high:     { type: Number, default: DEFAULT_RISK_THRESHOLDS.high },
      critical: { type: Number, default: DEFAULT_RISK_THRESHOLDS.critical },
    },

    // ── Advocate allocation ──────────────────────────────────────────────────
    advocateAllocation: {
      mode: { type: String, enum: ALLOCATION_MODES, default: 'ranked' },
      weights: {
        type: Map,
        of: Number,
        default: () => new Map(Object.entries(DEFAULT_ALLOCATION_WEIGHTS)),
      },
      // Stop suggesting an advocate already carrying this many open matters.
      maxOpenMattersPerAdvocate: { type: Number, default: 25 },
    },

    // ── SLAs, in days ────────────────────────────────────────────────────────
    slas: {
      acknowledgeDemand:     { type: Number, default: 3 },
      assessLiability:       { type: Number, default: 14 },
      assessQuantum:         { type: Number, default: 21 },
      respondToDemand:       { type: Number, default: 30 },
      appointAdvocate:       { type: Number, default: 7 },
      advocateProgressReport:{ type: Number, default: 30 },
    },

    // ── Documents & disclosure ───────────────────────────────────────────────
    documentRequirements: {
      // Document type codes that must be present before each action is allowed.
      beforeSettlement: { type: [String], default: [] },
      beforePayment:    { type: [String], default: ['discharge_voucher'] },
      beforeSuitDefence:{ type: [String], default: [] },
    },

    /**
     * Whether an Auditor may open privileged document *contents*.
     *
     * Default false: auditors see that a privileged document exists, its
     * metadata and its full access log, but not the text. Spec §21 grants
     * auditors read-everything while §22 requires document-level permissions;
     * this flag is where an insurer resolves that tension for themselves.
     */
    auditorSeesPrivilegedContents: { type: Boolean, default: false },

    // Signed download links expire this quickly.
    documentLinkTtlSeconds: { type: Number, default: 300 },

    // ── Retention ────────────────────────────────────────────────────────────
    retentionYears: { type: Number, default: 7 },

    updatedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
  },
  { timestamps: true }
);

// Any edit bumps the version, so snapshots taken by approvals stay meaningful.
legalConfigSchema.pre('save', function bumpVersion(next) {
  if (!this.isNew && this.isModified()) this.version += 1;
  next();
});

legalConfigSchema.plugin(softDelete);

module.exports = mongoose.model('LegalConfig', legalConfigSchema);
