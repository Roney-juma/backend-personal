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
  email: { type: String, required: true },
  services: [{ type: String }],
  ratings: {
    averageRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    reviews: [{
      customerId: { type: ObjectId, ref: 'Customer' },
      rating: { type: Number },
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
