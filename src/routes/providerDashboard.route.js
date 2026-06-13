const express = require('express');
const router = express.Router();
const controller = require('../controllers/providerDashboard.controller');
const verifyToken = require('../middlewheres/verifyToken');

router.get('/', verifyToken(), controller.getOverview);
router.get('/revenue', verifyToken(), controller.getRevenueAnalytics);
router.get('/companies', verifyToken(), controller.getCompanyAnalytics);
router.get('/subscriptions', verifyToken(), controller.getSubscriptionAnalytics);
router.get('/activity', verifyToken(), controller.getRecentActivity);

module.exports = router;
