const mongoose = require("mongoose");
const bcrypt = require('bcryptjs');

// One policy = one entry; motor policies carry the insured vehicle. Fed by the
// insurer's book import; `status`/`expiryDate` drive claim-eligibility warnings.
const policySchema = new mongoose.Schema({
  policyNumber: { type: String, required: true, trim: true },
  policyType: { type: String, trim: true },
  status: {
    type: String,
    enum: ['active', 'lapsed', 'cancelled', 'expired'],
    default: 'active',
  },
  startDate: { type: Date },
  expiryDate: { type: Date },
  vehicle: {
    registration: { type: String, trim: true },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    year: { type: Number },
    chassisNumber: { type: String, trim: true },
  },

  /**
   * Third-party liability cover. Populated by the insurer's book import.
   *
   * These cap what the insurer answers for when the insured's vehicle injures
   * someone or damages their property, so the Legal module cannot compute an
   * exposure without them. Amounts are integer minor units (see utils/money.js);
   * null means unlimited for that head, which is common for bodily injury.
   */
  liabilityLimits: {
    propertyDamageMinor: { type: Number, default: null },
    bodilyInjuryMinor: { type: Number, default: null },
    // Caps the accident as a whole across every claimant, which is what actually
    // bites when one accident produces several injured parties.
    aggregateMinor: { type: Number, default: null },
  },
  excessMinor: { type: Number, default: null },
  exclusions: [{ type: String }],
  endorsements: [{
    code: { type: String },
    description: { type: String },
    effectiveFrom: { type: Date },
  }],
}, { _id: false });

const customerSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
    },
    lastName: {
      type: String,
    },

    // Optional at the schema level: imported book records may be phone-only
    // (they activate via WhatsApp OTP). Uniqueness is per tenant — see the
    // compound partial index below; the legacy global unique index is dropped
    // by scripts/migrate-tenancy.js.
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    username: {
      type: String,
    },
    phone: {
      type: String,
    },
    idNumber: {
      type: String,
      trim: true,
    },
    // Primary policy, mirrored from policies[0] — kept top-level for mobile-app
    // backward compatibility. Unique per tenant (compound index below).
    policyNumber: {
      type: String,
      required: true,
    },
    policyType: {
        type: String,
        required: true,
      },
    policies: [policySchema],
    Insurer: {
        type: String,
        required: true,
      },
    // Tenant link, resolved at creation from a supplied company id or the free-text
    // `Insurer` name. `Insurer` itself is kept for mobile-app backward compat.
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InsuranceCompany',
      index: true,
    },
    // No credential until the customer activates (OTP + set-password). Only
    // `active` accounts can log in, so password is required only then.
    password: {
      type: String,
      required: function () { return this.status === 'active'; },
    },
    // imported: in the book, no credential yet · invited: activation invite
    // sent · active: can log in. Self-registered/legacy accounts are active.
    status: {
      type: String,
      enum: ['imported', 'invited', 'active'],
      default: 'active',
    },
    source: {
      type: String,
      enum: ['import', 'self', 'admin'],
      default: 'self',
    },
    importBatchId: { type: String, index: true },
    emailVerified: { type: Boolean, default: false },
    invitedAt: { type: Date },
    activatedAt: { type: Date },
    accountType:{
      type: String,
      default: 'Customer',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletionRequestedAt: {
      type: Date,
      default: null,
    },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String },
    mustChangePassword: { type: Boolean, default: false },
    fcmToken: { type: String },
  },
  {
    timestamps: true,
  }
);

// Per-tenant uniqueness (the legacy GLOBAL unique indexes on email/policyNumber/
// username are dropped by scripts/migrate-tenancy.js): policy numbers collide
// across insurers, and the same person may hold policies with two insurers.
customerSchema.index({ company: 1, policyNumber: 1 }, { unique: true });
customerSchema.index(
  { company: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
// Multikey index covering every policy in the array, for book lookups.
customerSchema.index({ company: 1, 'policies.policyNumber': 1 });
// A third-party demand names a VEHICLE REGISTRATION, not a policy number — the
// claimant has no idea what the policy number is. Without this the "which cover
// answers this demand?" lookup is a full collection scan.
customerSchema.index({ company: 1, 'policies.vehicle.registration': 1 });
// Activation lookup: find an imported record by email within one insurer.
customerSchema.index({ company: 1, status: 1 });

customerSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  if (!user.password) return false; // imported records have no credential yet
  return bcrypt.compare(password, user.password);
};
const customer = mongoose.model("customer", customerSchema);
module.exports = customer;
