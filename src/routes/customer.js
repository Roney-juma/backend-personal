
const express = require("express");
const customerController = require("../controllers/customerController")
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");
const verifyToken = require("../middlewheres/verifyToken");
const authLimiter = require("../middlewheres/authLimiter");
const router = express.Router();



router.post("/register", customerController.createCustomer)
router.post("/login", authLimiter, customerController.login)
router.post('/forgot-password', authLimiter, customerController.forgotPassword);
router.post('/reset-password', authLimiter, customerController.resetPassword);

// MFA + first-login password change (mobile customer)
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);
router.post('/mfa/setup', verifyToken(), mfaController.setup('Customer'));
router.post('/mfa/enable', verifyToken(), mfaController.enable('Customer'));
router.post('/mfa/disable', verifyToken(), mfaController.disable('Customer'));
router.post('/change-password', verifyToken(), passwordController.changePassword('Customer'));
router.get('/stats',verifyToken(), customerController.getCustomerStats)
router.get("/",verifyToken(), customerController.getAllCustomers)
router.get('/get-garages/:claimId',verifyToken(), customerController.getGarage)
router.put('/updateCustomer/:customerId',verifyToken(), customerController.updateCustomer)
router.get('/myClaims/:customerId',verifyToken(), customerController.getCustomerClaims)
router.patch('/:id/fcm-token', verifyToken(), customerController.updateFcmToken)
router.patch('/request-deletion', customerController.requestAccountDeletion)

module.exports = router;