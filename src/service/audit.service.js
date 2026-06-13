const { AuditLog } = require('../models');

module.exports.getAuditLogs = async (filters = {}, options = {}) => {
  try {
    const {
      action,
      module,
      resourceId,
      performedBy,
      severity,
      category,
      success,
      startDate,
      endDate,
      search,
    } = filters;

    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      populateUser = false,
    } = options;

    const query = {};

    if (action)      query.action      = action;
    if (module)      query.module      = module;
    if (resourceId)  query.resourceId  = resourceId;
    if (performedBy) query.performedBy = performedBy;
    if (severity)    query.severity    = severity;
    if (category)    query.category    = category;
    if (success !== undefined) query.success = success === 'true' || success === true;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate)   query.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      query.$or = [
        { actionDescription: { $regex: search, $options: 'i' } },
        { performedByName:   { $regex: search, $options: 'i' } },
        { performedByEmail:  { $regex: search, $options: 'i' } },
        { endpoint:          { $regex: search, $options: 'i' } },
        { module:            { $regex: search, $options: 'i' } },
      ];
    }

    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
    const skip = (page - 1) * limit;

    let auditLogsQuery = AuditLog.find(query).sort(sortOptions).skip(skip).limit(limit);

    if (populateUser) {
      auditLogsQuery = auditLogsQuery.populate('performedBy', 'fullName email');
    }

    const [auditLogs, totalLogs] = await Promise.all([
      auditLogsQuery.exec(),
      AuditLog.countDocuments(query),
    ]);

    return {
      auditLogs,
      pagination: {
        page,
        limit,
        total: totalLogs,
        totalPages: Math.ceil(totalLogs / limit),
      },
    };
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    throw new Error('Failed to fetch audit logs');
  }
};
