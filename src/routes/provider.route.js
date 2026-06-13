const express = require('express');
const router = express.Router();

router.use('/companies', require('./insuranceCompany.route'));
router.use('/plans', require('./subscriptionPlan.route'));
router.use('/subscriptions', require('./companySubscription.route'));
router.use('/invoices', require('./invoice.route'));
router.use('/api-keys', require('./apiKey.route'));
router.use('/support', require('./supportTicket.route'));
router.use('/dashboard', require('./providerDashboard.route'));

module.exports = router;
