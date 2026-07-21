const express = require('express');

const router = express.Router();
const userController = require("../controllers/users.controller");
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");
const verifyToken = require("../middlewheres/verifyToken");
const requirePortalUser = require("../middlewheres/requirePortalUser");
const authLimiter = require("../middlewheres/authLimiter");

// User management is portal-only: mobile actor tokens (Customer/Garage/...)
// must not reach these routes. MFA + change-password stay self-service.

router.get('/',verifyToken(), requirePortalUser, userController.getAllUsers)
router.post('/create', verifyToken(), requirePortalUser, userController.createUser)
router.post('/login', authLimiter, userController.login)

// Multi-factor authentication (insurer portal users)
router.post('/mfa/setup', verifyToken(), mfaController.setup('User'))
router.post('/mfa/enable', verifyToken(), mfaController.enable('User'))
router.post('/mfa/disable', verifyToken(), mfaController.disable('User'))
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin)
router.post('/change-password', verifyToken(), passwordController.changePassword('User'))
router.get('/company-users/:id',verifyToken(), requirePortalUser, userController.getCompanyUsers)
router.patch('/update/:id',verifyToken(), requirePortalUser, userController.updateAdminUser)
router.get('/:id',verifyToken(), requirePortalUser, userController.getAdminUser)
router.patch('/delete/:id',verifyToken(), requirePortalUser, userController.deleteAdminUser)
router.post('/reset-password',verifyToken(), requirePortalUser, userController.resetPassword);




module.exports = router;
