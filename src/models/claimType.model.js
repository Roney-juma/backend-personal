const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const claimTypeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  // Tenant that owns this claim type. null = global/default type visible to every tenant.
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true, default: null },
  description: {
    type: String,
    trim: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Claim-type names are unique within a tenant (and among the global defaults),
// not globally — two insurers can each define their own "Windscreen".
// NOTE: the migration script must drop the old unique index on { name: 1 }.
claimTypeSchema.index({ company: 1, name: 1 }, { unique: true });

claimTypeSchema.plugin(softDelete);

const ClaimType = mongoose.model('ClaimType', claimTypeSchema);
module.exports = ClaimType;
