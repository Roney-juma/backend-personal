const express = require('express');
const router = express.Router();
const controller = require('../controllers/providerDashboard.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.get('/', verifyProviderToken(), controller.getOverview);
router.get('/revenue', verifyProviderToken(), controller.getRevenueAnalytics);
router.get('/companies', verifyProviderToken(), controller.getCompanyAnalytics);
router.get('/claims-by-company', verifyProviderToken(), controller.getClaimsByCompany);
router.get('/subscriptions', verifyProviderToken(), controller.getSubscriptionAnalytics);
router.get('/activity', verifyProviderToken(), controller.getRecentActivity);

module.exports = router;
