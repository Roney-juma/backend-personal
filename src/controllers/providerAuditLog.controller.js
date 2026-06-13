const service = require('../service/providerAuditLog.service');

const getAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 50, ...filters } = req.query;
        const result = await service.getAuditLogs(filters, {
            page:  parseInt(page),
            limit: Math.min(parseInt(limit), 200), // cap at 200 per page
        });
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAuditLogById = async (req, res) => {
    try {
        const log = await service.getAuditLogById(req.params.id);
        if (!log) return res.status(404).json({ message: 'Audit log entry not found' });
        res.status(200).json(log);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAuditStats = async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const stats = await service.getAuditStats(parseInt(days));
        res.status(200).json(stats);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getLogsByUser = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const result = await service.getLogsByUser(req.params.userId, {
            page:  parseInt(page),
            limit: parseInt(limit),
        });
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getLogsByResource = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const result = await service.getLogsByResource(req.params.resourceId, {
            page:  parseInt(page),
            limit: parseInt(limit),
        });
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const purgeOldLogs = async (req, res) => {
    try {
        const { beforeDate } = req.body;
        if (!beforeDate) {
            return res.status(400).json({ message: 'beforeDate is required (ISO date string)' });
        }
        const parsed = new Date(beforeDate);
        if (isNaN(parsed.getTime())) {
            return res.status(400).json({ message: 'beforeDate is not a valid date' });
        }
        const result = await service.purgeOldLogs(beforeDate);
        res.status(200).json({
            message:      `Purged ${result.deletedCount} audit log(s) before ${beforeDate}`,
            deletedCount: result.deletedCount,
            beforeDate,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getAuditLogs,
    getAuditLogById,
    getAuditStats,
    getLogsByUser,
    getLogsByResource,
    purgeOldLogs,
};
