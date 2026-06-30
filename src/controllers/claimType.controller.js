const claimTypeService = require('../service/claimType.service');

const createClaimType = async (req, res) => {
  try {
    const claimType = await claimTypeService.createClaimType(req.body);
    res.status(201).json(claimType);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllClaimTypes = async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const claimTypes = await claimTypeService.getAllClaimTypes(activeOnly);
    res.status(200).json(claimTypes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getClaimTypeById = async (req, res) => {
  try {
    const claimType = await claimTypeService.getClaimTypeById(req.params.id);
    res.status(200).json(claimType);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

const updateClaimType = async (req, res) => {
  try {
    const claimType = await claimTypeService.updateClaimType(req.params.id, req.body);
    res.status(200).json(claimType);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteClaimType = async (req, res) => {
  try {
    await claimTypeService.deleteClaimType(req.params.id);
    res.status(200).json({ message: 'Claim type deleted successfully' });
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

module.exports = {
  createClaimType,
  getAllClaimTypes,
  getClaimTypeById,
  updateClaimType,
  deleteClaimType,
};
