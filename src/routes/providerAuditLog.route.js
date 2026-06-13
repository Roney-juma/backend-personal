const express = require('express');
const router = express.Router();
const controller = require('../controllers/providerAuditLog.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

// Static routes must come before /:id
router.get('/stats',              verifyProviderToken(), controller.getAuditStats);
router.get('/user/:userId',       verifyProviderToken(), controller.getLogsByUser);
router.get('/resource/:resourceId', verifyProviderToken(), controller.getLogsByResource);

// General list + single entry
router.get('/',    verifyProviderToken(), controller.getAuditLogs);
router.get('/:id', verifyProviderToken(), controller.getAuditLogById);

// Destructive maintenance — restrict to admin role in production via verifyProviderToken(['adminRoleId'])
router.delete('/purge', verifyProviderToken(), controller.purgeOldLogs);

module.exports = router;
