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
  company: { type: String, required: true },
  ratings: {
    averageRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    reviews: [{
      customerId: { type: ObjectId, ref: 'Customer' },
      rating: { type: Number },
      feedback: { type: String },
      createdAt: { type: Date, default: Date.now }
    }]
  },
  password: {
    type: String,
    required: true,
  },
  partsAvailable: [{ type: String }]
}, { timestamps: true });

supplierSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  return bcrypt.compare(password, user.password);
};

module.exports = mongoose.model('Supplier', supplierSchema);
