const auditService = require("../service/audit.service");

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

    const auditLogs = await auditService.getAuditLogs(filters, options);
    res.status(200).json(auditLogs);
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs', error: error.message });
  }
};

module.exports = { logAudit };
