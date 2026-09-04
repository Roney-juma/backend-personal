const PolicyType = require('../models/policyType.model');
const logger = require('../middlewheres/logger');

/**
 * The built-in Kenyan motor covers, seeded on first read.
 *
 * These exist so the field is selectable from the moment the system is
 * installed: a dropdown that starts empty is worse than the free-text box it
 * replaced, because it blocks the user instead of merely letting them improvise.
 * They are global (company: null), so a tenant sees them alongside anything they
 * add themselves and can retire any they do not sell.
 */
const DEFAULT_TYPES = [
  {
    name: 'Comprehensive',
    code: 'COMP',
    description: 'Covers damage to the insured vehicle as well as third-party liability.',
    coversOwnDamage: true,
    order: 10,
  },
  {
    name: 'Third Party, Fire and Theft',
    code: 'TPFT',
    description: 'Third-party liability, plus fire and theft of the insured vehicle. No accidental own damage.',
    coversOwnDamage: false,
    order: 20,
  },
  {
    name: 'Third Party Only',
    code: 'TPO',
    description: 'Third-party liability only — the statutory minimum. No cover for the insured vehicle.',
    coversOwnDamage: false,
    order: 30,
  },
  {
    name: 'Commercial Vehicle',
    code: 'COMM',
    description: 'Cover for vehicles used for business — goods carriage, own goods, general cartage.',
    coversOwnDamage: true,
    order: 40,
  },
  {
    name: 'Public Service Vehicle',
    code: 'PSV',
    description: 'Cover for vehicles carrying passengers for hire — matatus, buses, taxis.',
    coversOwnDamage: true,
    order: 50,
  },
  {
    name: 'Motor Trade',
    code: 'TRADE',
    description: 'Cover for vehicles in the custody of a garage or dealer rather than an owner.',
    coversOwnDamage: true,
    order: 60,
  },
];

/**
 * Put the built-in types in place if they are not there already.
 *
 * Idempotent by name via upsert, so it is safe on every boot and every read: a
 * second call changes nothing, and a type an insurer has edited or deactivated
 * is left exactly as they left it (setOnInsert, not set).
 */
const seedDefaults = async () => {
  try {
    const ops = DEFAULT_TYPES.map((t) => ({
      updateOne: {
        filter: { name: t.name, company: null },
        update: { $setOnInsert: { ...t, company: null, isActive: true } },
        upsert: true,
      },
    }));
    const res = await PolicyType.bulkWrite(ops, { ordered: false });
    const added = res.upsertedCount || 0;
    if (added > 0) logger.info(`[policyType] seeded ${added} built-in policy type(s)`);
    return added;
  } catch (error) {
    // Never fatal: a failed seed leaves the list shorter, it does not break the
    // request that triggered it.
    logger.warn(`[policyType] could not seed defaults: ${error.message}`);
    return 0;
  }
};

const createPolicyType = async (data) => {
  const policyType = new PolicyType(data);
  await policyType.save();
  return policyType;
};

/**
 * `company`: the requester's tenant. Company-scoped requesters see the built-in
 * defaults (company: null) plus their own; a null company (platform staff) sees
 * everything. Mirrors claimType.service — see the note there.
 */
const getAllPolicyTypes = async (activeOnly = false, company = null) => {
  // Seeded lazily rather than in a migration so a fresh database, a restored
  // backup and a new tenant all get the same list without anyone remembering.
  await seedDefaults();

  const filter = activeOnly ? { isActive: true } : {};
  if (company) filter.company = { $in: [null, company] };
  return PolicyType.find(filter).sort({ order: 1, name: 1 });
};

const getPolicyTypeById = async (id) => {
  const policyType = await PolicyType.findById(id);
  if (!policyType) throw new Error('Policy type not found');
  return policyType;
};

/**
 * Company users may only mutate their OWN company's types. A built-in default
 * (company: null) simply does not match their filter and surfaces as not found,
 * which is the intended answer: one tenant must not be able to rename or delete
 * a cover every other tenant relies on.
 */
const updatePolicyType = async (id, data, company = null) => {
  const filter = company ? { _id: id, company } : { _id: id };
  const policyType = await PolicyType.findOneAndUpdate(filter, data, { new: true, runValidators: true });
  if (!policyType) throw new Error('Policy type not found');
  return policyType;
};

const deletePolicyType = async (id, company = null) => {
  const filter = company ? { _id: id, company } : { _id: id };
  const policyType = await PolicyType.softDeleteOne(filter);
  if (!policyType) throw new Error('Policy type not found');
  return policyType;
};

module.exports = {
  createPolicyType,
  getAllPolicyTypes,
  getPolicyTypeById,
  updatePolicyType,
  deletePolicyType,
  seedDefaults,
  DEFAULT_TYPES,
};
