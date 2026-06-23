const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');

const investigatorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  contactNumber: { type: String, required: true },
  licenseNumber: { type: String, required: false },
  specializations: [{ type: String }], // e.g. ['fraud', 'fire', 'theft', 'collision']
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
  fcmToken: { type: String },
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

investigatorSchema.methods.isPasswordMatch = async function (password) {
  return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('Investigator', investigatorSchema);
