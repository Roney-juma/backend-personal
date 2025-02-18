const {AuditLog} = require('../models');

module.exports.getAuditLogs = async (filters = {}, options = {}) => {
  try {
    const {
      action,
      collectionName,
      documentId,
      userId,
      startDate,
      endDate,
      search,
    } = filters;

    const {
      page = 1,
      limit = 10,
      sortBy = 'timestamp',
      sortOrder = 'desc',
      populateUser = false,
    } = options;

    // Build the query
    const query = {};

    if (action) query.action = action;
    if (collectionName) query.collectionName = collectionName;
    if (documentId) query.documentId = documentId;
    if (userId) query.userId = userId;

    // Date range filtering
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    // Search functionality (e.g., by changes or document ID)
    if (search) {
      query.$or = [
        { documentId: { $regex: search, $options: 'i' } },
        { 'changes.newData': { $regex: search, $options: 'i' } },
        { 'changes.oldData': { $regex: search, $options: 'i' } },
      ];
    }

    // Sorting
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Pagination
    const skip = (page - 1) * limit;

    // Fetch audit logs
    let auditLogsQuery = AuditLog.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limit);

    // Populate user details if required
    if (populateUser) {
      auditLogsQuery = auditLogsQuery.populate('userId', 'name email');
    }

    const auditLogs = await auditLogsQuery.exec();

    // Get total count for pagination
    const totalLogs = await AuditLog.countDocuments(query);

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