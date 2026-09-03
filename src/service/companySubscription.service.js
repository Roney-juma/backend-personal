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

/**
 * Put a company onto a plan because they have paid for it.
 *
 * Called when an invoice raised to SELL a plan is marked paid, which is the
 * moment access should begin. Before this, the only ways to start a
 * subscription were to create it unpaid and hope the money followed, or to
 * notice the payment and key it in by hand.
 *
 * A company holds one live subscription at a time in this model — the portal
 * shows one, the Companies list picks one — so an existing live subscription is
 * moved onto the paid plan and extended, rather than a second one being created
 * alongside it. That covers renewal, upgrade and downgrade with one path; a
 * company with nothing live gets a fresh subscription.
 *
 * Returns the subscription, or null when the plan no longer exists.
 */
const activateFromPayment = async ({ company, plan, billingCycle = 'monthly', startAt = new Date() }) => {
  const planDoc = await SubscriptionPlan.findById(plan);
  if (!planDoc) return null;

  const amount = billingCycle === 'annually' ? planDoc.price.annually : planDoc.price.monthly;

  const existing = await CompanySubscription.findOne({
    company,
    status: { $in: ['active', 'trial'] },
  }).sort({ endDate: -1 });

  /**
   * Extend from whichever is later: the end of the term they already hold, or
   * now. Paying early should add a period to what they have rather than cutting
   * it short, and paying after a lapse should not back-date the new term into
   * days they could not use.
   */
  const from = existing && new Date(existing.endDate) > startAt ? new Date(existing.endDate) : new Date(startAt);
  const endDate = new Date(from);
  if (billingCycle === 'annually') endDate.setFullYear(endDate.getFullYear() + 1);
  else endDate.setMonth(endDate.getMonth() + 1);

  if (existing) {
    existing.plan = planDoc._id;
    existing.billingCycle = billingCycle;
    existing.amount = amount;
    existing.currency = planDoc.currency;
    existing.status = 'active';
    existing.endDate = endDate;
    existing.nextBillingDate = new Date(endDate);
    // A trial that has been paid for is no longer a trial.
    existing.trialEndDate = undefined;
    return existing.save();
  }

  return new CompanySubscription({
    company,
    plan: planDoc._id,
    billingCycle,
    status: 'active',
    startDate: new Date(startAt),
    endDate,
    nextBillingDate: new Date(endDate),
    amount,
    currency: planDoc.currency,
  }).save();
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
  activateFromPayment,
};
