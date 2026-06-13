const mongoose = require('mongoose');

const insuranceCompanySchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true, unique: true, trim: true },
    registrationNumber: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    phone: { type: String, trim: true },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      country: { type: String },
      postalCode: { type: String },
    },
    contactPerson: {
      name: { type: String },
      email: { type: String },
      phone: { type: String },
      position: { type: String },
    },
    logo: { type: String },
    website: { type: String },
    status: {
      type: String,
      enum: ['active', 'inactive', 'suspended', 'pending'],
      default: 'pending',
    },
    onboardedAt: { type: Date },
    lastActiveAt: { type: Date },
    notes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InsuranceCompany', insuranceCompanySchema);
