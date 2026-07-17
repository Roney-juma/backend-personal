const InsuranceCompany = require('../models/insuranceCompany.model');
const CompanySubscription = require('../models/companySubscription.model');
const Invoice = require('../models/invoice.model');
const SupportTicket = require('../models/supportTicket.model');
const ApiKey = require('../models/apiKey.model');
const CompanyActivity = require('../models/companyActivity.model');

const getOverview = async () => {
  const [
    totalCompanies,
    activeCompanies,
    pendingCompanies,
    suspendedCompanies,
    activeSubscriptions,
    trialSubscriptions,
    revenueStats,
    openTickets,
    criticalTickets,
    activeApiKeys,
  ] = await Promise.all([
    InsuranceCompany.countDocuments(),
    InsuranceCompany.countDocuments({ status: 'active' }),
    InsuranceCompany.countDocuments({ status: 'pending' }),
    InsuranceCompany.countDocuments({ status: 'suspended' }),
    CompanySubscription.countDocuments({ status: 'active' }),
    CompanySubscription.countDocuments({ status: 'trial' }),
    Invoice.aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    SupportTicket.countDocuments({ status: 'open' }),
    SupportTicket.countDocuments({ status: 'open', priority: 'critical' }),
    ApiKey.countDocuments({ status: 'active' }),
  ]);

  const outstandingResult = await Invoice.aggregate([
    { $match: { status: { $in: ['sent', 'overdue'] } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  return {
    companies: {
      total: totalCompanies,
      active: activeCompanies,
      pending: pendingCompanies,
      suspended: suspendedCompanies,
    },
    subscriptions: {
      active: activeSubscriptions,
      trial: trialSubscriptions,
    },
    billing: {
      totalRevenue: revenueStats[0]?.total || 0,
      outstandingAmount: outstandingResult[0]?.total || 0,
    },
    support: {
      openTickets,
      criticalTickets,
    },
    activeApiKeys,
  };
};

const getRevenueAnalytics = async () => {
  const monthly = await Invoice.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: { year: { $year: '$paidDate' }, month: { $month: '$paidDate' } },
        revenue: { $sum: '$total' },
        invoiceCount: { $sum: 1 },
      },
    },
    // Take the most recent 12 months, then re-sort ascending for display.
    { $sort: { '_id.year': -1, '_id.month': -1 } },
    { $limit: 12 },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const byCurrency = await Invoice.aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$currency', total: { $sum: '$total' }, count: { $sum: 1 } } },
  ]);

  const overdue = await Invoice.aggregate([
    { $match: { status: 'overdue' } },
    { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
  ]);

  return { monthly, byCurrency, overdue: overdue[0] || { total: 0, count: 0 } };
};

const getCompanyAnalytics = async () => {
  const byStatus = await InsuranceCompany.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const recentlyOnboarded = await InsuranceCompany.find({ status: 'active' })
    .select('companyName email onboardedAt status')
    .sort({ onboardedAt: -1 })
    .limit(10);

  const growthByMonth = await InsuranceCompany.aggregate([
    {
      $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    // Take the most recent 12 months, then re-sort ascending for display.
    { $sort: { '_id.year': -1, '_id.month': -1 } },
    { $limit: 12 },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  return { byStatus, recentlyOnboarded, growthByMonth };
};

const getSubscriptionAnalytics = async () => {
  const byStatus = await CompanySubscription.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const byPlan = await CompanySubscription.aggregate([
    {
      $lookup: {
        from: 'subscriptionplans',
        localField: 'plan',
        foreignField: '_id',
        as: 'planDetails',
      },
    },
    { $unwind: '$planDetails' },
    {
      $group: {
        _id: '$planDetails.name',
        count: { $sum: 1 },
        totalRevenue: { $sum: '$amount' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const expiringIn30Days = await CompanySubscription.find({
    status: 'active',
    endDate: { $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  })
    .populate('company', 'companyName email')
    .populate('plan', 'name')
    .select('endDate billingCycle amount');

  return { byStatus, byPlan, expiringIn30Days };
};

const getRecentActivity = async (limit = 20) => {
  const [recentCompanies, recentInvoices, recentTickets, activityLogs] = await Promise.all([
    InsuranceCompany.find().select('companyName status createdAt').sort({ createdAt: -1 }).limit(5),
    Invoice.find().populate('company', 'companyName').select('invoiceNumber total status issuedDate createdAt').sort({ createdAt: -1 }).limit(5),
    SupportTicket.find().populate('company', 'companyName').select('ticketNumber subject status priority createdAt').sort({ createdAt: -1 }).limit(5),
    CompanyActivity.find().populate('company', 'companyName').sort({ createdAt: -1 }).limit(Number(limit)),
  ]);

  return { recentCompanies, recentInvoices, recentTickets, activityLogs };
};

module.exports = {
  getOverview,
  getRevenueAnalytics,
  getCompanyAnalytics,
  getSubscriptionAnalytics,
  getRecentActivity,
};
