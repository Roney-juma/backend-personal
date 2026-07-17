const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ObjectId } = require("mongodb")

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  location: {
    name: String,
    estate: String,
    city: String,
    state: String,
    zip: String,
    longitude: Number,
    latitude: Number
  },
  company: { type: String, required: true }, // free-text supplier business name (not a ref)
  // Insurance company this supplier belongs to (the company of the user who created it).
  insuranceCompany: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },
  ratings: {
    averageRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    reviews: [{
      reviewerId: { type: ObjectId, ref: 'Garage', required: true },
      reviewerType: { type: String, enum: ['Garage'], required: true },
      claimId: { type: ObjectId, ref: 'Claim' },
      rating: { type: Number, min: 1, max: 5, required: true },
      feedback: { type: String },
      createdAt: { type: Date, default: Date.now }
    }]
  },
  password: {
    type: String,
    required: true,
  },
  partsAvailable: [{ type: String }],
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date },
  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: { type: String },
  mustChangePassword: { type: Boolean, default: false },
  fcmToken: { type: String },
}, { timestamps: true });

supplierSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  return bcrypt.compare(password, user.password);
};

module.exports = mongoose.model('Supplier', supplierSchema);
