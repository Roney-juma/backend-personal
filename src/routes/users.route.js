const express = require('express');

const router = express.Router();
const userController = require("../controllers/users.controller");
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");
const verifyToken = require("../middlewheres/verifyToken");
const authLimiter = require("../middlewheres/authLimiter");

// router.use(verifyToken)

router.get('/',verifyToken(),userController.getAllUsers)
router.post('/create', verifyToken(), userController.createUser)
router.post('/login', authLimiter, userController.login)

// Multi-factor authentication (insurer portal users)
router.post('/mfa/setup', verifyToken(), mfaController.setup('User'))
router.post('/mfa/enable', verifyToken(), mfaController.enable('User'))
router.post('/mfa/disable', verifyToken(), mfaController.disable('User'))
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin)
router.post('/change-password', verifyToken(), passwordController.changePassword('User'))
router.get('/company-users/:id',verifyToken(), userController.getCompanyUsers)
router.patch('/update/:id',verifyToken(),userController.updateAdminUser)
router.get('/:id',verifyToken(), userController.getAdminUser)
router.patch('/delete/:id',verifyToken(), userController.deleteAdminUser)
router.post('/reset-password',verifyToken(), userController.resetPassword);




module.exports = router;
