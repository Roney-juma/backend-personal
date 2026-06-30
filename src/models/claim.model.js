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
    longitude:
    {
      type: Number,
      required: false
    },
    latitude:
    {
      type: Number,
    },
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
    reportNumber: { type: String },
    officerName: { type: String },
    department: { type: String },
  },
  supportingDocuments: {
    photos: [String],
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
    enum: ['Pending', 'Approved', 'Rejected', 'Resubmitted', 'Assessment', 'Assessed', 'Awarded', 'Repair', 'Garage', 'Re-Assessment', 'ReAssessed', 'SelfRepair', 'Completed', 'UnderInvestigation', 'Investigated', 'GlassApproved', 'GlassRepair'],
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
}, { timestamps: true });

const Claim = mongoose.model('Claim', claimSchema);
module.exports = Claim;
