const auditService = require("../service/audit.service");
const logger = require('../middlewheres/logger');
const { getRequesterCompany } = require('../utils/requesterCompany');

const logAudit = async (req, res) => {
  try {
    const { page, limit, sortBy, sortOrder, populateUser, ...filters } = req.query;
    const options = {
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.max(1, parseInt(limit, 10) || 10),
      sortBy: sortBy || 'createdAt',
      sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
      populateUser: populateUser === 'true',
    };

    // Company users only see their own company's logs; platform staff see all.
    // Resolved server-side — a client-supplied `company` filter is never honoured.
    const company = await getRequesterCompany(req);
    const auditLogs = await auditService.getAuditLogs(filters, options, company);
    res.status(200).json(auditLogs);
  } catch (error) {
    logger.error('Error fetching audit logs: %s', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs', error: error.message });
  }
};

module.exports = { logAudit };
