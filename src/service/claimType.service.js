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

const getAllClaimTypes = async (activeOnly = false) => {
  try {
    const filter = activeOnly ? { isActive: true } : {};
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

const updateClaimType = async (id, data) => {
  try {
    const claimType = await ClaimType.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!claimType) throw new Error('Claim type not found');
    return claimType;
  } catch (error) {
    logger.error('Error updating claim type:', error);
    throw error;
  }
};

const deleteClaimType = async (id) => {
  try {
    const claimType = await ClaimType.findByIdAndDelete(id);
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
