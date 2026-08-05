const express = require('express');

const router = express.Router();
const userController = require("../controllers/users.controller");
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");
const verifyToken = require("../middlewheres/verifyToken");
const requirePortalUser = require("../middlewheres/requirePortalUser");
const requirePermission = require("../middlewheres/requirePermission");
const authLimiter = require("../middlewheres/authLimiter");

// User management is portal-only: mobile actor tokens (Customer/Garage/...)
// must not reach these routes. MFA + change-password stay self-service.

router.get('/',verifyToken(), requirePortalUser, requirePermission('VIEW_USERS'), userController.getAllUsers)
router.post('/create', verifyToken(), requirePortalUser, requirePermission('CREATE_USER'), userController.createUser)
router.post('/login', authLimiter, userController.login)

// Multi-factor authentication (insurer portal users)
router.post('/mfa/setup', verifyToken(), mfaController.setup('User'))
router.post('/mfa/enable', verifyToken(), mfaController.enable('User'))
router.post('/mfa/disable', verifyToken(), mfaController.disable('User'))
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin)
router.post('/change-password', verifyToken(), passwordController.changePassword('User'))
// Self-service profile (must be declared BEFORE the '/:id' route so 'me' isn't
// captured as an id). No VIEW_USERS/UPDATE_USER permission — a user always may
// read and edit their OWN profile.
router.get('/me', verifyToken(), userController.getMyProfile)
router.patch('/me', verifyToken(), userController.updateMyProfile)
router.get('/company-users/:id',verifyToken(), requirePortalUser, requirePermission('VIEW_USERS'), userController.getCompanyUsers)
router.patch('/update/:id',verifyToken(), requirePortalUser, requirePermission('UPDATE_USER'), userController.updateAdminUser)
router.get('/:id',verifyToken(), requirePortalUser, requirePermission('VIEW_USERS'), userController.getAdminUser)
router.patch('/delete/:id',verifyToken(), requirePortalUser, requirePermission('DELETE_USER'), userController.deleteAdminUser)
router.post('/reset-password',verifyToken(), requirePortalUser, requirePermission('UPDATE_USER'), userController.resetPassword);




module.exports = router;
