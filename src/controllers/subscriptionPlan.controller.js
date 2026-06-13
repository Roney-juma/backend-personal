const subscriptionPlanService = require('../service/subscriptionPlan.service');

const createPlan = async (req, res) => {
  try {
    const plan = await subscriptionPlanService.createPlan(req.body);
    res.status(201).json(plan);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllPlans = async (req, res) => {
  try {
    const plans = await subscriptionPlanService.getAllPlans(req.query);
    res.status(200).json(plans);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPlanById = async (req, res) => {
  try {
    const plan = await subscriptionPlanService.getPlanById(req.params.id);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    res.status(200).json(plan);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updatePlan = async (req, res) => {
  try {
    const plan = await subscriptionPlanService.updatePlan(req.params.id, req.body);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    res.status(200).json(plan);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const togglePlan = async (req, res) => {
  try {
    const plan = await subscriptionPlanService.togglePlan(req.params.id);
    res.status(200).json(plan);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deletePlan = async (req, res) => {
  try {
    await subscriptionPlanService.deletePlan(req.params.id);
    res.status(200).json({ message: 'Plan deleted successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = { createPlan, getAllPlans, getPlanById, updatePlan, togglePlan, deletePlan };
