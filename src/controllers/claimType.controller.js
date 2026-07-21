const claimTypeService = require('../service/claimType.service');
const { getRequesterCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');

const createClaimType = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const data = { ...req.body };
    // Company users always create for their own tenant; staff may pass a
    // company explicitly or omit it to create a global type.
    if (company) data.company = company;
    const claimType = await claimTypeService.createClaimType(data);
    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'ClaimType',
      actionDescription: `Created claim type ${claimType.name}`,
      resourceType: 'ClaimType',
      resourceId: claimType._id,
      statusCode: 201,
      success: true,
      changes: { old: null, new: { name: claimType.name } },
    });
    res.status(201).json(claimType);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllClaimTypes = async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const company = await getRequesterCompany(req);
    const claimTypes = await claimTypeService.getAllClaimTypes(activeOnly, company);
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
    const company = await getRequesterCompany(req);
    const claimType = await claimTypeService.updateClaimType(req.params.id, req.body, company);
    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'ClaimType',
      actionDescription: `Updated claim type ${claimType.name}`,
      resourceType: 'ClaimType',
      resourceId: claimType._id,
      statusCode: 200,
      success: true,
    });
    res.status(200).json(claimType);
  } catch (error) {
    // Cross-tenant (or missing) targets surface as not found, never as forbidden.
    const notFound = error.message === 'Claim type not found';
    res.status(notFound ? 404 : 400).json({ message: error.message });
  }
};

const deleteClaimType = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const deleted = await claimTypeService.deleteClaimType(req.params.id, company);
    await writeAuditLog(req, {
      action: 'DELETE',
      module: 'ClaimType',
      actionDescription: `Deleted claim type ${deleted.name}`,
      resourceType: 'ClaimType',
      resourceId: deleted._id,
      statusCode: 200,
      success: true,
    });
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
