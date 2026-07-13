const mongoose = require("mongoose");
const bcrypt = require('bcryptjs');
const { ObjectId } = require("mongodb")

const garageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  location: {
    name: String,
    estate: String,
    city: String,
    state: String,
    zip: String,
    longitude: Number,
    latitude: Number
  },
  pendingWork: { type: Number, default: 0 },
  email: { type: String, required: true },
  password: {
    type: String,
    required: true,
  },
  contactNumber: { type: String, required: true },
  accountType: {
    type: String,
    default: 'Garage',
  },
  services: [{ type: String }],
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date },
  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: { type: String },
  mustChangePassword: { type: Boolean, default: false },
  fcmToken: { type: String },
  ratings: {
    averageRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    reviews: [{
      reviewerId: { type: ObjectId, required: true },
      reviewerType: { type: String, enum: ['Customer', 'Assessor'], required: true },
      claimId: { type: ObjectId, ref: 'Claim' },
      rating: { type: Number, min: 1, max: 5, required: true },
      feedback: { type: String },
      createdAt: { type: Date, default: Date.now }
    }]
  }
}, { timestamps: true });

garageSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  return bcrypt.compare(password, user.password);
};

module.exports = mongoose.model('Garage', garageSchema);
