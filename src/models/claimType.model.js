const mongoose = require('mongoose');

const claimTypeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

const ClaimType = mongoose.model('ClaimType', claimTypeSchema);
module.exports = ClaimType;
