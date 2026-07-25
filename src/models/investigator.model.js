const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { ObjectId } = require('mongodb');

const investigatorSchema = new mongoose.Schema({
  // Insurance company this investigator belongs to.
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  contactNumber: { type: String, required: true },
  licenseNumber: { type: String, required: false },
  specializations: [{ type: String }],
  accountType: { type: String, default: 'Investigator' },
  location: {
    name: String,
    estate: String,
    city: String,
    state: String,
    zip: String,
    longitude: Number,
    latitude: Number,
  },
  pendingInvestigations: { type: Number, default: 0 },
  ratings: {
    averageRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    reviews: [{
      reviewerId: { type: ObjectId, required: true },
      reviewerType: { type: String, enum: ['Customer', 'Admin'], required: true },
      claimId: { type: ObjectId, ref: 'Claim' },
      rating: { type: Number, min: 1, max: 5, required: true },
      feedback: { type: String },
      createdAt: { type: Date, default: Date.now },
    }],
  },
}, { timestamps: true });

investigatorSchema.plugin(softDelete);

module.exports = mongoose.model('Investigator', investigatorSchema);
