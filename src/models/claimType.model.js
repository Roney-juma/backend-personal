const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

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

claimTypeSchema.plugin(softDelete);

const ClaimType = mongoose.model('ClaimType', claimTypeSchema);
module.exports = ClaimType;
