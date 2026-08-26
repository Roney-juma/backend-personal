const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const softDelete = require('./plugins/softDelete');


const partSchema = new Schema({
  partName: { type: String, required: false },
  cost: { type: Number, required: false },
});


const bidSchema = new Schema({
  bidderType: {
    type: String,
    enum: ['assessor', 'garage'],
  },
  ratings: {
    type: Number,
    required: false
  },
  assessorId: {
    type: Schema.Types.ObjectId,
    ref: 'Assessor',
    required: function () { return this.bidderType === 'assessor'; }
  },
  garageId: {
    type: Schema.Types.ObjectId,
    ref: 'Garage',
    required: function () { return this.bidderType === 'garage'; }
  },
  awardedSupplierId: {
    type: Schema.Types.ObjectId,
    ref: 'Supplier',
    required: false
  },
  parts: {
    type: [partSchema],
    required: false
  },
  garageDetails:
  {
    type: Object,
    required: false
    },
  assessorDetails:
    {
      type: Object,
      required: false
      },
      pendingWork:
      {
        type: Object,
        required: false
        },
  amount:
  {
    type: Number,
    required: false
  },
  description:
  {
    type: String,
    required: false
  },
  timeline:
  {
    type: String,
    required: false
  },
  bidDate: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    // 'completed' closes the loop for the winner: an awarded bid stays 'awarded'
    // for the whole job, so without a terminal state the partner portal counts a
    // finished repair as outstanding work forever.
    enum: ['pending', 'awarded', 'rejected', 'completed'],
    default: 'pending',
  },
  completedAt: { type: Date },
});


/**
 * A claim opened because a THIRD PARTY reported an accident the insured never
 * did. The Legal Officer filing it has the registration and the date; the
 * insured-side detail (driver licence, police abstract, damage photos) is not
 * available yet and may never be.
 *
 * Such a record is held out of assessment and bidding until that detail arrives
 * — see claim.service — so relaxing these validators does not let an
 * under-specified claim into the normal repair flow.
 *
 * Note on binding: nested paths (incidentDetails.date, policeReport.reportNumber)
 * validate with `this` bound to the SUB-DOCUMENT rather than the claim, so
 * reading `this.source` directly would always be undefined. ownerDocument()
 * walks back up to the claim.
 */
function insuredSideRequiredNested() {
  const root = typeof this.ownerDocument === 'function' ? this.ownerDocument() : this;
  return root?.source !== 'third_party_notification';
}

const claimSchema = new Schema({
  // Tenant scope — stamped from the claimant customer's `company` at creation.
  // Unset on legacy claims filed before multi-tenancy; those stay globally visible.
  company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  claimTypeId: { type: Schema.Types.ObjectId, ref: 'ClaimType', required: false },
  claimant: {
    name: { type: String },
    address: { type: String },
    phone: { type: String },
    email: { type: String },
  },
  incidentDetails: {
    date: { type: Date, required: insuredSideRequiredNested },
    time: { type: String, required: insuredSideRequiredNested },
    location: { type: String, required: insuredSideRequiredNested },
    longitude: { type: Number, required: insuredSideRequiredNested },
    latitude: { type: Number, required: insuredSideRequiredNested },
    description: { type: String, required: insuredSideRequiredNested },
    weatherConditions: { type: String },
    roadConditions: { type: String },
  },
  vehiclesInvolved: [{
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    VIN: { type: String, required: false },
    licensePlate: { type: String, required: true },
  }],
  drivers: [{
    name: { type: String, required: true },
    contactInfo: {
      phone: { type: String, required: true },
      email: { type: String, required: true },
    },
    driverLicenseNumber: { type: String, required: true },
  }],
  passengers: [{
    name: { type: String },
    contactInfo: {
      phone: { type: String },
      email: { type: String },
    },
  }],
  damage: {
    yourVehicle: { type: String },
    otherVehicles: { type: String },
    property: { type: String },
  },
  description: {
    type: String
  },
  damagedParts: {
    type: String
  },
  injuries: [{
    person: { type: String, required: true },
    description: { type: String, required: true },
  }],
  witnesses: [{
    name: { type: String, required: true },
    contactInfo: {
      phone: { type: String, required: true },
      email: { type: String, required: true },
    },
  }],
  policeReport: {
    reportNumber: { type: String, required: insuredSideRequiredNested },
    officerName: { type: String, required: insuredSideRequiredNested },
    department: { type: String, required: insuredSideRequiredNested },
  },
  supportingDocuments: {
    photos: {
      type: [String],
      validate: {
        validator(v) {
          const root = typeof this.ownerDocument === 'function' ? this.ownerDocument() : this;
          // A third party reporting an accident has no photos of the insured's
          // vehicle — and never will. See insuredSideRequiredNested above.
          if (root?.source === 'third_party_notification') return true;
          return Array.isArray(v) && v.length > 0;
        },
        message: 'At least one supporting photo is required',
      },
    },
    videos: [String],
    repairEstimates: [String],
    medicalReports: [String],
  },
  additionalInfo: {
    towingDetails: {
      company: { type: String },
      location: { type: String },
    },
    receipts: [String],
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'Resubmitted', 'Assessment', 'Assessed', 'Awarded', 'Repair', 'Garage', 'Re-Assessment', 'ReAssessed', 'SelfRepair', 'UnderRepair', 'Completed', 'UnderInvestigation', 'Investigated', 'GlassApproved', 'GlassRepair'],
    default: 'Pending'
  },
  reAssessmentReport: {
    notes: { type: String },
    photos: [String],
    outcome: { type: String, enum: ['Passed', 'Failed'] },
    assessorId: { type: Schema.Types.ObjectId, ref: 'Assessor' },
    submittedAt: { type: Date },
  },
  garageRepairReport: {
    garageId: { type: Schema.Types.ObjectId, ref: 'Garage' },
    workDone: { type: String },
    vehicleCondition: { type: String },
    partsSalvaged: [{ partName: { type: String }, description: { type: String } }],
    partsReplaced: [{ partName: { type: String }, cost: { type: Number } }],
    photos: [String],
    reportDocument: {
      url: { type: String },
      fileName: { type: String },
      uploadedAt: { type: Date },
    },
    totalRepairCost: { type: Number },
    submittedAt: { type: Date },
  },
  fraud: {
    suspected: { type: Boolean, default: false },
    investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation' },
    awardedInvestigator: {
      investigatorId: { type: Schema.Types.ObjectId, ref: 'Investigator' },
      assignedDate: { type: Date },
    },
    riskScore: { type: Number, default: 0 },
    riskLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    flags: [{
      ruleId: { type: String },
      label: { type: String },
      score: { type: Number },
      detectedAt: { type: Date, default: Date.now },
    }],
    lastCheckedAt: { type: Date },
  },
  selfRepair: {
    opted: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['Pending', 'Submitted', 'Approved', 'Rejected', 'Paid', 'In-Review', 'DepositPaid', 'SettlementPaid'],
      default: 'Pending'
    },
    estimate: {
      parts: { type: [partSchema], default: [] },
      other: { type: Number, default: 0 },
      description: { type: String },
    },
    amountRequested: { type: Number },
    amountApproved: { type: Number },
    // Cash-in-lieu two-stage payment
    totalAwardedAmount: { type: Number },
    depositPercentage: { type: Number },
    depositAmount: { type: Number },
    depositPaidAt: { type: Date },
    finalSettlementAmount: { type: Number },
    finalSettlementPaidAt: { type: Date },
    receipts: [String],
    description: { type: String },
    bankingDetails: {
      paymentMethod: { type: String },
      phoneNumber: { type: String },
      bankName: { type: String },
      accountHolderName: { type: String },
      accountNumber: { type: String },
    },
    reAssessmentReport: {
      notes: { type: String },
      recommendedAmount: { type: Number },
      assessedAt: { type: Date },
    },
    submittedAt: { type: Date },
    approvedAt: { type: Date },
    rejectionReason: { type: String },
    paidAt: { type: Date },
  },
  repairs: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RepairRequest',
  }],
  bids: [bidSchema],
  awardedAssessor: {
    assessorId: { type: Schema.Types.ObjectId, ref: 'Assessor' },
    name: { type: String },
    awardedAmount: { type: Number },
    awardedDate: { type: Date }
  },
  awardedGarage: {
    garageId: { type: Schema.Types.ObjectId, ref: 'Garage' },
    name: { type: String },
    awardedAmount: { type: Number },
    awardedDate: { type: Date }
  },
  rejectionReason:
  {
    type: String
    },
  repairDate: { type: Date },
  assessmentReport: {
    type: Object

  },
  supplierBids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupplyBid'
  }],
  glassRepair: {
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    appointmentDate: { type: Date },
    completedAt: { type: Date },
    notes: { type: String },
    status: {
      type: String,
      enum: ['Pending', 'Assigned', 'Completed'],
      default: 'Pending',
    },
  },
  /**
   * Third-party legal exposure roll-up.
   *
   * Mirrors the `fraud` block above: a cached summary so claim lists can show a
   * legal badge without joining ThirdPartyClaim on every row. The exposures
   * themselves live in their own collection — one accident routinely produces
   * several third-party claimants, each with their own fault share, value,
   * reserve and statutory clock.
   *
   * Deliberately NOT reflected in `status`. Litigation runs in parallel with the
   * insured's own claim, not as a stage of it: the insured's car can be repaired
   * and this claim Completed while a passenger's injury claim runs for three
   * more years.
   */
  legal: {
    referred: { type: Boolean, default: false },
    // Aggregate across every third-party claimant on this accident.
    thirdPartyClaimCount: { type: Number, default: 0 },
    openThirdPartyClaimCount: { type: Number, default: 0 },
    litigatedCount: { type: Number, default: 0 },
    totalReserveMinor: { type: Number, default: 0 },
    totalExposureMinor: { type: Number, default: 0 },
    // Whether the accident's aggregate exposure has reached the policy limit —
    // the point at which the insured carries the excess personally.
    limitEroded: { type: Boolean, default: false },
    excessOfLimitMinor: { type: Number, default: 0 },
    // Soonest time-bar across all claimants, so a claim list can be sorted by
    // "what expires first" without touching the exposures.
    nearestTimeBar: { type: Date },
    riskScore: { type: Number, default: 0 },
    riskLevel: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'low' },
    lastCheckedAt: { type: Date },
    recomputedAt: { type: Date },
  },

  /**
   * The cover that answers this accident. Resolved at filing, or at third-party
   * registration by vehicle registration + accident date.
   *
   * Third-party exposure is capped by the policy's liability limits, so the
   * module needs to know which policy applies — the customer link alone is not
   * enough once a customer holds more than one.
   */
  policyRef: {
    policyNumber: { type: String, trim: true },
    // Copied at resolution: a policy is renewed and endorsed over the years a
    // matter runs, and what matters is the cover in force on the accident date.
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
  },

  /**
   * How this accident record came into existence.
   *
   * `third_party_notification` marks a claim opened by a Legal Officer because a
   * third party reported an accident the insured never did. Such a record has no
   * insured-side damage and must not enter assessment or bidding until the
   * insured's details arrive.
   */
  source: {
    type: String,
    enum: ['insured', 'third_party_notification', 'import', 'ai_intake'],
    default: 'insured',
  },

  // Set when a third-party notification and the insured's later report turn out
  // to be the same accident. The surviving record carries `mergedFrom`.
  mergedInto: { type: Schema.Types.ObjectId, ref: 'Claim' },
  mergedFrom: [{ type: Schema.Types.ObjectId, ref: 'Claim' }],
  mergedAt: { type: Date },

  ai: {
    status: { type: String, enum: ['pending', 'analyzing', 'analyzed', 'error'], default: 'pending' },
    riskScore: { type: Number },
    riskBand: { type: String, enum: ['low', 'medium', 'high'] },
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiAnalysis' },
    analyzedAt: { type: Date },
    // Claimant vehicle fingerprint, cached so continuity checks on later stages
    // don't re-run the vision call over the same photos.
    baselineFingerprint: {
      promptVersion: { type: String },
      photosHash: { type: String },
      fingerprint: { type: mongoose.Schema.Types.Mixed },
      extractedAt: { type: Date },
    },
  },
}, { timestamps: true });

// Indexes matching the app's actual query filters. Without these, every list/lookup
// (by status, customer, awarded assessor/garage, or nested bids) is a full collection
// scan that degrades linearly as claims grow.
claimSchema.index({ status: 1, createdAt: -1 });            // status lists, newest-first
claimSchema.index({ company: 1, status: 1 });               // tenant-scoped portal lists/stats
claimSchema.index({ customerId: 1 });                       // claims by customer
claimSchema.index({ 'claimant.email': 1 });                 // customer portal lookups
claimSchema.index({ claimTypeId: 1 });                      // glass vs motor filtering
claimSchema.index({ 'awardedAssessor.assessorId': 1 });     // assessor's awarded claims
claimSchema.index({ 'awardedGarage.garageId': 1 });         // garage's awarded claims
claimSchema.index({ 'bids.assessorId': 1 });                // getAssessorBids
claimSchema.index({ 'bids.garageId': 1 });                  // getGarageBids

// Legal module: tenant-scoped lists of accidents carrying third-party exposure,
// and "what expires first" ordering for the time-bar register.
claimSchema.index({ company: 1, 'legal.referred': 1, 'legal.nearestTimeBar': 1 });
// Matching an incoming third-party demand to an accident already on file, by the
// registration the demand names. Multikey over vehiclesInvolved.
claimSchema.index({ company: 1, 'vehiclesInvolved.licensePlate': 1, 'incidentDetails.date': -1 });

claimSchema.plugin(softDelete);

const Claim = mongoose.model('Claim', claimSchema);
module.exports = Claim;
