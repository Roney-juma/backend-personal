const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

/**
 * The kinds of cover an insurer sells.
 *
 * `policyType` was free text everywhere it appeared — on the customer record, in
 * the import, in the portal's policy editor — so the same cover arrived as
 * "Comprehensive", "comprehensive", "Comp" and "COMPREHENSIVE" depending on who
 * typed it. Nothing could be counted, filtered or reasoned about, and the AI
 * intake had no way to tell a claimant what their cover actually was.
 *
 * Modelled on ClaimType deliberately: same tenant scoping, same soft delete,
 * same "global default plus the tenant's own" read rule — an insurer that sells
 * something unusual adds it without every other tenant seeing it.
 */
const policyTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Tenant that owns this type. null = a built-in default, visible to everyone.
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true, default: null },
  description: { type: String, trim: true },
  /**
   * Short form as it appears on a certificate or sticker — "TPO", "TPFT".
   * Kept because a policy book import will carry the abbreviation as often as
   * the full name, and matching on it saves a manual reconciliation pass.
   */
  code: { type: String, trim: true, uppercase: true },
  /**
   * Whether this cover pays for damage to the insured's OWN vehicle. Third-party
   * only does not, which is the single most consequential difference at intake:
   * it decides whether there is anything to assess on the claimant's own car.
   */
  coversOwnDamage: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  // Lower sorts first, so the common cover leads the dropdown rather than
  // whatever happens to come first alphabetically.
  order: { type: Number, default: 100 },
}, { timestamps: true });

// Unique within a tenant, and among the global defaults — two insurers can each
// define their own "Motor Trade" without colliding.
policyTypeSchema.index({ company: 1, name: 1 }, { unique: true });

policyTypeSchema.plugin(softDelete);

const PolicyType = mongoose.model('PolicyType', policyTypeSchema);
module.exports = PolicyType;
