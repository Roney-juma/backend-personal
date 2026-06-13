const ProviderAuditLog = require('../models/providerAuditLog.model');

// Called exclusively by the audit middleware – fire-and-forget
const createLog = async (data) => {
    const log = new ProviderAuditLog(data);
    return log.save();
};

// ─── Main query (with all filters) ────────────────────────────────────────────

const getAuditLogs = async (filters = {}, { page = 1, limit = 50 } = {}) => {
    const query = buildQuery(filters);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
        ProviderAuditLog.find(query)
            .populate('performedBy',     'fullName email username')
            .populate('performedByRole', 'name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        ProviderAuditLog.countDocuments(query),
    ]);

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
};

const getAuditLogById = async (id) => {
    return ProviderAuditLog.findById(id)
        .populate('performedBy',     'fullName email username')
        .populate('performedByRole', 'name');
};

// ─── Drill-down views ─────────────────────────────────────────────────────────

const getLogsByUser = async (userId, { page = 1, limit = 50 } = {}) => {
    const skip = (page - 1) * limit;
    const query = { performedBy: userId };

    const [data, total] = await Promise.all([
        ProviderAuditLog.find(query)
            .populate('performedByRole', 'name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        ProviderAuditLog.countDocuments(query),
    ]);

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
};

const getLogsByResource = async (resourceId, { page = 1, limit = 50 } = {}) => {
    const skip = (page - 1) * limit;
    const query = { resourceId };

    const [data, total] = await Promise.all([
        ProviderAuditLog.find(query)
            .populate('performedBy', 'fullName email username')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        ProviderAuditLog.countDocuments(query),
    ]);

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
};

// ─── Statistics ────────────────────────────────────────────────────────────────

const getAuditStats = async (days = 30) => {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const match = { $match: { createdAt: { $gte: since } } };

    const [
        totalLogs,
        failedCount,
        bySeverity,
        byModule,
        byAction,
        byCategory,
        byMethod,
        topUsers,
        topFailedEndpoints,
        dailyActivity,
    ] = await Promise.all([
        ProviderAuditLog.countDocuments({ createdAt: { $gte: since } }),

        ProviderAuditLog.countDocuments({ createdAt: { $gte: since }, success: false }),

        ProviderAuditLog.aggregate([
            match,
            { $group: { _id: '$severity', count: { $sum: 1 } } },
        ]),

        ProviderAuditLog.aggregate([
            match,
            { $group: { _id: '$module', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]),

        ProviderAuditLog.aggregate([
            match,
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
        ]),

        ProviderAuditLog.aggregate([
            match,
            { $group: { _id: '$category', count: { $sum: 1 } } },
        ]),

        ProviderAuditLog.aggregate([
            match,
            { $group: { _id: '$method', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]),

        ProviderAuditLog.aggregate([
            match,
            { $match: { performedBy: { $ne: null } } },
            {
                $group: {
                    _id:              '$performedBy',
                    performedByName:  { $first: '$performedByName' },
                    performedByEmail: { $first: '$performedByEmail' },
                    totalActions:     { $sum: 1 },
                    failedActions:    { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
                    criticalActions:  { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
                    lastActive:       { $max: '$createdAt' },
                },
            },
            { $sort: { totalActions: -1 } },
            { $limit: 10 },
        ]),

        ProviderAuditLog.aggregate([
            match,
            { $match: { success: false } },
            { $group: { _id: '$endpoint', count: { $sum: 1 }, lastSeen: { $max: '$createdAt' } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
        ]),

        // Day-by-day breakdown for charts
        ProviderAuditLog.aggregate([
            match,
            {
                $group: {
                    _id: {
                        year:  { $year: '$createdAt' },
                        month: { $month: '$createdAt' },
                        day:   { $dayOfMonth: '$createdAt' },
                    },
                    total:    { $sum: 1 },
                    failures: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
                    critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
                },
            },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
        ]),
    ]);

    return {
        period:             { days, since },
        totalLogs,
        failedCount,
        successRate:        totalLogs ? ((totalLogs - failedCount) / totalLogs * 100).toFixed(1) + '%' : '100%',
        bySeverity:         Object.fromEntries(bySeverity.map(s => [s._id, s.count])),
        byModule:           byModule.map(m => ({ module: m._id, count: m.count })),
        byAction:           byAction.map(a => ({ action: a._id, count: a.count })),
        byCategory:         Object.fromEntries(byCategory.map(c => [c._id, c.count])),
        byMethod:           Object.fromEntries(byMethod.map(m => [m._id, m.count])),
        topUsers,
        topFailedEndpoints,
        dailyActivity,
    };
};

// ─── Maintenance ───────────────────────────────────────────────────────────────

const purgeOldLogs = async (beforeDate) => {
    const result = await ProviderAuditLog.deleteMany({ createdAt: { $lt: new Date(beforeDate) } });
    return { deletedCount: result.deletedCount, beforeDate };
};

// ─── Query builder ─────────────────────────────────────────────────────────────

function buildQuery(filters) {
    const query = {};

    if (filters.performedBy) query.performedBy = filters.performedBy;
    if (filters.module)      query.module       = filters.module;
    if (filters.action)      query.action       = filters.action;
    if (filters.severity)    query.severity     = filters.severity;
    if (filters.category)    query.category     = filters.category;
    if (filters.resourceId)  query.resourceId   = filters.resourceId;
    if (filters.resourceType)query.resourceType = filters.resourceType;
    if (filters.method)      query.method       = filters.method.toUpperCase();
    if (filters.statusCode)  query.statusCode   = parseInt(filters.statusCode);

    if (filters.success !== undefined) {
        query.success = filters.success === 'true' || filters.success === true;
    }

    if (filters.from || filters.to) {
        query.createdAt = {};
        if (filters.from) query.createdAt.$gte = new Date(filters.from);
        if (filters.to)   query.createdAt.$lte = new Date(filters.to);
    }

    if (filters.search) {
        const rx = { $regex: filters.search, $options: 'i' };
        query.$or = [
            { actionDescription: rx },
            { endpoint:          rx },
            { performedByName:   rx },
            { performedByEmail:  rx },
        ];
    }

    return query;
}

module.exports = {
    createLog,
    getAuditLogs,
    getAuditLogById,
    getLogsByUser,
    getLogsByResource,
    getAuditStats,
    purgeOldLogs,
};
