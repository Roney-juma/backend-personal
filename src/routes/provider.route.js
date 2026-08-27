const express = require('express');
const router = express.Router();
const providerAuditLogger = require('../middlewheres/providerAuditLogger');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');
const authLimiter = require('../middlewheres/authLimiter');
const providerUserController = require('../controllers/providerUser.controller');
const mfaController = require('../controllers/mfa.controller');
const passwordController = require('../controllers/password.controller');

// Public — login and the MFA second step do not require an existing token
router.post('/login', authLimiter, providerUserController.login);
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);

// All routes below are audit-logged and require a valid ProviderUser token
router.use(providerAuditLogger);

// Multi-factor authentication enrollment (provider portal staff)
router.post('/mfa/setup',   verifyProviderToken(), mfaController.setup('ProviderUser'));
router.post('/mfa/enable',  verifyProviderToken(), mfaController.enable('ProviderUser'));
router.post('/mfa/disable', verifyProviderToken(), mfaController.disable('ProviderUser'));
router.post('/change-password', verifyProviderToken(), passwordController.changePassword('ProviderUser'));

// Slide the session forward against a still-valid token. Capped by
// PROVIDER_SESSION_MAX_HOURS — see the controller.
router.post('/refresh', verifyProviderToken(), providerUserController.refresh);

// Self-service profile for the authenticated provider user.
router.get('/me', verifyProviderToken(), providerUserController.getMe);
router.patch('/me', verifyProviderToken(), providerUserController.updateMe);

router.get('/users',                    verifyProviderToken(), providerUserController.getAllUsers);
router.post('/users',                   verifyProviderToken(), providerUserController.createUser);
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

// Internal workspace: the platform team's own meetings/calendar and task tracker.
router.use('/meetings',      require('./meeting.route'));
router.use('/tasks',         require('./task.route'));
// The sales pipeline: which insurers we are talking to and where each stands.
router.use('/prospects',     require('./prospect.route'));

module.exports = router;
