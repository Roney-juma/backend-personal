const ClaimType = require('../models/claimType.model');
const logger = require('../middlewheres/logger');

const createClaimType = async (data) => {
  try {
    const claimType = new ClaimType(data);
    await claimType.save();
    return claimType;
  } catch (error) {
    logger.error('Error creating claim type:', error);
    throw error;
  }
};

// `company`: requester's tenant. Company-scoped requesters see global types
// (company: null) plus their own; a null company (platform staff / legacy
// tokens) sees everything.
const getAllClaimTypes = async (activeOnly = false, company = null) => {
  try {
    const filter = activeOnly ? { isActive: true } : {};
    if (company) filter.company = { $in: [null, company] };
    return await ClaimType.find(filter).sort({ name: 1 });
  } catch (error) {
    logger.error('Error fetching claim types:', error);
    throw error;
  }
};

const getClaimTypeById = async (id) => {
  try {
    const claimType = await ClaimType.findById(id);
    if (!claimType) throw new Error('Claim type not found');
    return claimType;
  } catch (error) {
    logger.error('Error fetching claim type:', error);
    throw error;
  }
};

// Company users may only mutate their own company's claim types (a cross-tenant
// or global target simply doesn't match and surfaces as not found); staff
// (company null) are unrestricted.
const updateClaimType = async (id, data, company = null) => {
  try {
    const filter = company ? { _id: id, company } : { _id: id };
    const claimType = await ClaimType.findOneAndUpdate(filter, data, { new: true, runValidators: true });
    if (!claimType) throw new Error('Claim type not found');
    return claimType;
  } catch (error) {
    logger.error('Error updating claim type:', error);
    throw error;
  }
};

const deleteClaimType = async (id, company = null) => {
  try {
    const filter = company ? { _id: id, company } : { _id: id };
    const claimType = await ClaimType.softDeleteOne(filter);
    if (!claimType) throw new Error('Claim type not found');
    return claimType;
  } catch (error) {
    logger.error('Error deleting claim type:', error);
    throw error;
  }
};

module.exports = {
  createClaimType,
  getAllClaimTypes,
  getClaimTypeById,
  updateClaimType,
  deleteClaimType,
};
