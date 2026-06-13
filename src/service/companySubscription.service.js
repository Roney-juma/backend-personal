const CompanySubscription = require('../models/companySubscription.model');
const SubscriptionPlan = require('../models/subscriptionPlan.model');

const createSubscription = async (data) => {
  const { company, plan, billingCycle, startDate, trialDays } = data;

  const planDoc = await SubscriptionPlan.findById(plan);
  if (!planDoc) throw new Error('Plan not found');
  if (!planDoc.isActive) throw new Error('Plan is not available');

  const start = new Date(startDate || Date.now());
  const amount = billingCycle === 'annually' ? planDoc.price.annually : planDoc.price.monthly;

  const endDate = new Date(start);
  if (billingCycle === 'annually') {
    endDate.setFullYear(endDate.getFullYear() + 1);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }

  const nextBillingDate = new Date(endDate);

  let trialEndDate;
  if (trialDays && trialDays > 0) {
    trialEndDate = new Date(start);
    trialEndDate.setDate(trialEndDate.getDate() + trialDays);
  }

  const subscription = new CompanySubscription({
    company,
    plan,
    billingCycle: billingCycle || 'monthly',
    status: trialDays ? 'trial' : 'active',
    startDate: start,
    endDate,
    trialEndDate,
    nextBillingDate,
    amount,
    currency: planDoc.currency,
  });

  return subscription.save();
};

const getAllSubscriptions = async ({ status, company, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (company) filter.company = company;
  const skip = (page - 1) * limit;
  const [subscriptions, total] = await Promise.all([
    CompanySubscription.find(filter)
      .populate('company', 'companyName email')
      .populate('plan', 'name price currency')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    CompanySubscription.countDocuments(filter),
  ]);
  return { subscriptions, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getSubscriptionById = async (id) => {
  return CompanySubscription.findById(id)
    .populate('company', 'companyName email phone')
    .populate('plan');
};

const getSubscriptionsByCompany = async (companyId) => {
  return CompanySubscription.find({ company: companyId })
    .populate('plan')
    .sort({ createdAt: -1 });
};

const updateSubscription = async (id, data) => {
  return CompanySubscription.findByIdAndUpdate(id, data, { new: true })
    .populate('company', 'companyName email')
    .populate('plan', 'name price');
};

const cancelSubscription = async (id, reason) => {
  return CompanySubscription.findByIdAndUpdate(
    id,
    { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, autoRenew: false },
    { new: true }
  );
};

const renewSubscription = async (id) => {
  const sub = await CompanySubscription.findById(id).populate('plan');
  if (!sub) throw new Error('Subscription not found');

  const newEnd = new Date(sub.endDate);
  if (sub.billingCycle === 'annually') {
    newEnd.setFullYear(newEnd.getFullYear() + 1);
  } else {
    newEnd.setMonth(newEnd.getMonth() + 1);
  }

  sub.endDate = newEnd;
  sub.nextBillingDate = new Date(newEnd);
  sub.status = 'active';
  return sub.save();
};

module.exports = {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionById,
  getSubscriptionsByCompany,
  updateSubscription,
  cancelSubscription,
  renewSubscription,
};
