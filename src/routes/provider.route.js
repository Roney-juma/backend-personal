const express = require('express');
const router = express.Router();
const providerAuditLogger = require('../middlewheres/providerAuditLogger');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');
const providerUserController = require('../controllers/providerUser.controller');

// Public — login does not require an existing token
router.post('/login', providerUserController.login);

// All routes below are audit-logged and require a valid ProviderUser token
router.use(providerAuditLogger);

router.get('/users',                    verifyProviderToken(), providerUserController.getAllUsers);
router.post('/users',                    providerUserController.createUser);
router.get('/users/:id',                verifyProviderToken(), providerUserController.getUserById);
router.patch('/users/:id',              verifyProviderToken(), providerUserController.updateUser);
router.patch('/users/:id/deactivate',   verifyProviderToken(), providerUserController.deactivateUser);
router.post('/users/reset-password',    verifyProviderToken(), providerUserController.resetPassword);

router.use('/companies',     require('./insuranceCompany.route'));
router.use('/plans',         require('./subscriptionPlan.route'));
router.use('/subscriptions', require('./companySubscription.route'));
router.use('/invoices',      require('./invoice.route'));
router.use('/api-keys',      require('./apiKey.route'));
router.use('/support',       require('./supportTicket.route'));
router.use('/dashboard',     require('./providerDashboard.route'));
router.use('/audit-logs',    require('./providerAuditLog.route'));
router.use('/demo-requests', require('./demoRequest.route'));

module.exports = router;
