const mongoose = require('mongoose');
const Schema = mongoose.Schema;


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
    enum: ['pending', 'awarded', 'rejected'],
    default: 'pending',
  },
});

const claimSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  claimTypeId: { type: Schema.Types.ObjectId, ref: 'ClaimType', required: false },
  claimant: {
    name: { type: String },
    address: { type: String },
    phone: { type: String },
    email: { type: String },
  },
  incidentDetails: {
    date: { type: Date, required: true },
    time: { type: String, required: true },
    location: { type: String, required: true },
    longitude: { type: Number, required: true },
    latitude: { type: Number, required: true },
    description: { type: String, required: true },
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
    reportNumber: { type: String, required: true },
    officerName: { type: String, required: true },
    department: { type: String, required: true },
  },
  supportingDocuments: {
    photos: {
      type: [String],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
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
    receipts: [String],
    photos: [String],
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
    awardedAmount: { type: Number },
    awardedDate: { type: Date }
  },
  awardedGarage: {
    garageId: { type: Schema.Types.ObjectId, ref: 'Garage' },
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
claimSchema.index({ customerId: 1 });                       // claims by customer
claimSchema.index({ 'claimant.email': 1 });                 // customer portal lookups
claimSchema.index({ claimTypeId: 1 });                      // glass vs motor filtering
claimSchema.index({ 'awardedAssessor.assessorId': 1 });     // assessor's awarded claims
claimSchema.index({ 'awardedGarage.garageId': 1 });         // garage's awarded claims
claimSchema.index({ 'bids.assessorId': 1 });                // getAssessorBids
claimSchema.index({ 'bids.garageId': 1 });                  // getGarageBids

const Claim = mongoose.model('Claim', claimSchema);
module.exports = Claim;
