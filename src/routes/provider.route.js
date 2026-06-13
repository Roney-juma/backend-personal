const express = require('express');
const router = express.Router();
const providerAuditLogger = require('../middlewheres/providerAuditLogger');

// Automatically logs every request that passes through any provider route
router.use(providerAuditLogger);

router.use('/companies',     require('./insuranceCompany.route'));
router.use('/plans',         require('./subscriptionPlan.route'));
router.use('/subscriptions', require('./companySubscription.route'));
router.use('/invoices',      require('./invoice.route'));
router.use('/api-keys',      require('./apiKey.route'));
router.use('/support',       require('./supportTicket.route'));
router.use('/dashboard',     require('./providerDashboard.route'));
router.use('/audit-logs',    require('./providerAuditLog.route'));

module.exports = router;
