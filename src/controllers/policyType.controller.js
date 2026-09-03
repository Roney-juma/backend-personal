const policyTypeService = require('../service/policyType.service');
const { getRequesterCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');

const createPolicyType = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const data = { ...req.body };
    // Company users always create for their own tenant; staff may pass a
    // company explicitly or omit it to create a global type.
    if (company) data.company = company;
    const policyType = await policyTypeService.createPolicyType(data);
    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'PolicyType',
      actionDescription: `Created policy type ${policyType.name}`,
      resourceType: 'PolicyType',
      resourceId: policyType._id,
      statusCode: 201,
      success: true,
      changes: { old: null, new: { name: policyType.name } },
    });
    res.status(201).json(policyType);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllPolicyTypes = async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const company = await getRequesterCompany(req);
    const policyTypes = await policyTypeService.getAllPolicyTypes(activeOnly, company);
    res.status(200).json(policyTypes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPolicyTypeById = async (req, res) => {
  try {
    const policyType = await policyTypeService.getPolicyTypeById(req.params.id);
    res.status(200).json(policyType);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

const updatePolicyType = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const policyType = await policyTypeService.updatePolicyType(req.params.id, req.body, company);
    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'PolicyType',
      actionDescription: `Updated policy type ${policyType.name}`,
      resourceType: 'PolicyType',
      resourceId: policyType._id,
      statusCode: 200,
      success: true,
    });
    res.status(200).json(policyType);
  } catch (error) {
    // Cross-tenant (or missing) targets surface as not found, never as forbidden.
    const notFound = error.message === 'Claim type not found';
    res.status(notFound ? 404 : 400).json({ message: error.message });
  }
};

const deletePolicyType = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const deleted = await policyTypeService.deletePolicyType(req.params.id, company);
    await writeAuditLog(req, {
      action: 'DELETE',
      module: 'PolicyType',
      actionDescription: `Deleted policy type ${deleted.name}`,
      resourceType: 'PolicyType',
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
  createPolicyType,
  getAllPolicyTypes,
  getPolicyTypeById,
  updatePolicyType,
  deletePolicyType,
};
