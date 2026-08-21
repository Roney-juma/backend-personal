const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const { Schema } = mongoose;

/**
 * A member of an insurer's own advocate panel.
 *
 * Confidential per tenant: unlike garages and assessors, panels are contractual
 * and there is no cross-tenant marketplace — one insurer must never see which
 * advocates another insurer instructs, nor which matters they are defending.
 *
 * This is OUR counsel. The claimant's advocate is the opposition and is recorded
 * as a plain sub-document on ThirdPartyClaim; they never get a record here,
 * because a record here can hold an account and log into the partner portal.
 *
 * Follows the shape of investigator.model.js plus the partner auth fields, so
 * the existing partner-fe shell (login, MFA, password reset) works unchanged.
 */

const firmSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    pin: { type: String, trim: true },            // KRA PIN, for payment
    lskNumber: { type: String, trim: true },      // Law Society practising number
    address: { type: String },
    physicalAddress: { type: String },
    bank: {
      bankName: { type: String },
      branch: { type: String },
      accountName: { type: String },
      accountNumber: { type: String },
    },
    contactPersons: [
      {
        name: { type: String },
        role: { type: String },
        phone: { type: String },
        email: { type: String },
      },
    ],
  },
  { _id: false }
);

/**
 * Computed performance, refreshed from cases and the ledger — never typed and
 * never left stale. These are the inputs the allocation engine ranks on.
 */
const performanceSchema = new Schema(
  {
    openMatters: { type: Number, default: 0 },
    closedMatters: { type: Number, default: 0 },
    successfulDefences: { type: Number, default: 0 },
    winRate: { type: Number, default: 0, min: 0, max: 1 },
    avgDurationDays: { type: Number, default: 0 },
    avgSettlementMinor: { type: Number, default: 0 },

    /**
     * Reserve minus settled, aggregated from the ledger: how much this advocate
     * has saved against what we had reserved. The single most commercially
     * meaningful measure of a defence advocate, and computable exactly because
     * both figures are ledger postings.
     */
    savingsMinor: { type: Number, default: 0 },

    overdueActions: { type: Number, default: 0 },
    outstandingReports: { type: Number, default: 0 },
    avgFeePerMatterMinor: { type: Number, default: 0 },
    recomputedAt: { type: Date },
  },
  { _id: false }
);

const advocateSchema = new Schema(
  {
    // Panels are per-insurer and confidential. Required, unlike the optional
    // company on legacy assessor/garage records.
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },

    name: { type: String, required: true, trim: true },
    firm: { type: firmSchema, required: true },

    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },

    lskNumber: { type: String, trim: true },   // the individual advocate's number
    admissionDate: { type: Date },

    practiceAreas: [{ type: String }],
    // Coverage, used by the allocation engine's proximity term.
    counties: [{ type: String }],
    courts: [{ type: String }],
    location: {
      name: String,
      city: String,
      county: String,
      longitude: Number,
      latitude: Number,
    },

    // ── Panel status ─────────────────────────────────────────────────────────
    approved: { type: Boolean, default: false, index: true },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    active: { type: Boolean, default: true, index: true },
    // Suspended advocates keep their history but are excluded from allocation.
    suspendedAt: { type: Date },
    suspensionReason: { type: String },

    rateAgreement: {
      basis: { type: String, enum: ['scale', 'hourly', 'fixed', 'blended'] },
      hourlyRateMinor: { type: Number },
      notes: { type: String },
      documentId: { type: Schema.Types.ObjectId, ref: 'LegalDocument' },
    },
    contractStart: { type: Date },
    contractExpiry: { type: Date, index: true },

    performance: { type: performanceSchema, default: () => ({}) },

    // ── Portal account (partner-fe, third role alongside Assessor and Garage) ─
    accountType: { type: String, default: 'Advocate' },
    password: { type: String },
    active_account: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: true },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    lastLogin: { type: Date },
    fcmToken: { type: String },
  },
  { timestamps: true }
);

// Email is unique per tenant, not globally: the same firm may sit on several
// insurers' panels, and each relationship is a separate confidential record.
advocateSchema.index({ company: 1, email: 1 }, { unique: true });
// The allocation engine's candidate query.
advocateSchema.index({ company: 1, approved: 1, active: 1 });

/**
 * Credential material must never leave the API. Mirrors the transform on
 * users.model.js — note that .lean() queries bypass this and must .select()
 * these fields out explicitly.
 */
advocateSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.mfaSecret;
    delete ret.failedLoginAttempts;
    delete ret.lockUntil;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

advocateSchema.plugin(softDelete);

module.exports = mongoose.model('Advocate', advocateSchema);
