const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

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
      username: { 
              type: String, 
              required: true, 
              unique: true 
          },
          fullName: { 
              type: String,
              required: true 
          },
          email: { 
              type: String, 
              required: true, 
              unique: true 
          },
          role: { 
              type: mongoose.Schema.Types.ObjectId, 
              ref: 'Role'
          },
          active: { type: Boolean, default: true },
          lastLogin: { type: Date },
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

insuranceCompanySchema.plugin(softDelete);

module.exports = mongoose.model('InsuranceCompany', insuranceCompanySchema);
