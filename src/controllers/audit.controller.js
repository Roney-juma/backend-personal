const auditService = require("../service/audit.service");

// Get audit Logs
const logAudit = async (req, res) => {

    try {
        const filters = req.query;
        const options = { sort: { createdAt: -1 } };
        const auditLogs = await auditService.getAuditLogs(filters, options);
        res.json(auditLogs);
        } catch (error) {
            res.status(500).json({ message: error.message });
            }
};
module.exports = {
    logAudit
};