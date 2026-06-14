const providerDashboardService = require('../service/providerDashboard.service');

const getOverview = async (req, res) => {
  try {
    const data = await providerDashboardService.getOverview();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getRevenueAnalytics = async (req, res) => {
  try {
    const data = await providerDashboardService.getRevenueAnalytics();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompanyAnalytics = async (req, res) => {
  try {
    const data = await providerDashboardService.getCompanyAnalytics();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getSubscriptionAnalytics = async (req, res) => {
  try {
    const data = await providerDashboardService.getSubscriptionAnalytics();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getRecentActivity = async (req, res) => {
  try {
    const { limit } = req.query;
    const data = await providerDashboardService.getRecentActivity(limit);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getOverview,
  getRevenueAnalytics,
  getCompanyAnalytics,
  getSubscriptionAnalytics,
  getRecentActivity,
};
