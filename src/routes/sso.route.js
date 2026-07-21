const express = require('express');
const router = express.Router();
const ssoController = require('../controllers/sso.controller');

// Microsoft Entra ID (Azure AD) OIDC single sign-on. All routes are inert until
// the tenant/client env vars are configured (see src/config/entra.js).
router.get('/entra/status', ssoController.status);
router.get('/entra/login', ssoController.login);
router.get('/entra/callback', ssoController.callback);

module.exports = router;
