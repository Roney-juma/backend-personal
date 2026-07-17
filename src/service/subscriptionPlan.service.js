const SubscriptionPlan = require('../models/subscriptionPlan.model');

const createPlan = async (data) => {
  const existing = await SubscriptionPlan.findOne({ name: data.name });
  if (existing) throw new Error('A plan with this name already exists');
  const plan = new SubscriptionPlan(data);
  return plan.save();
};

const getAllPlans = async ({ isActive } = {}) => {
  const filter = {};
  if (isActive !== undefined) filter.isActive = isActive === 'true' || isActive === true;
  return SubscriptionPlan.find(filter).sort({ 'price.monthly': 1 });
};

const getPlanById = async (id) => {
  return SubscriptionPlan.findById(id);
};

const updatePlan = async (id, data) => {
  return SubscriptionPlan.findByIdAndUpdate(id, data, { new: true });
};

const togglePlan = async (id) => {
  const plan = await SubscriptionPlan.findById(id);
  if (!plan) throw new Error('Plan not found');
  plan.isActive = !plan.isActive;
  return plan.save();
};

const deletePlan = async (id) => {
  const CompanySubscription = require('../models/companySubscription.model');
  const inUse = await CompanySubscription.findOne({ plan: id, status: 'active' });
  if (inUse) throw new Error('Cannot delete a plan that has active subscriptions');
  return SubscriptionPlan.softDeleteById(id);
};

module.exports = {
  createPlan,
  getAllPlans,
  getPlanById,
  updatePlan,
  togglePlan,
  deletePlan,
};
