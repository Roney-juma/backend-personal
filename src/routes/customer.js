
const express = require("express");
const customerController = require("../controllers/customerController")
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");
const verifyToken = require("../middlewheres/verifyToken");
const authLimiter = require("../middlewheres/authLimiter");
const requirePortalUser = require("../middlewheres/requirePortalUser");
const requirePermission = require("../middlewheres/requirePermission");
const router = express.Router();



router.post("/register", customerController.createCustomer)
// Portal-only: company admins add one or bulk-import customers (dryRun supported).
router.post("/import", verifyToken(), requirePortalUser, requirePermission('IMPORT_CUSTOMERS'), customerController.importCustomers)
router.post("/login", authLimiter, customerController.login)

// Mobile account activation — book-verified "registration" (public, rate-limited)
router.post("/verify-account", authLimiter, customerController.verifyAccount)
router.post("/verify-account/confirm", authLimiter, customerController.confirmVerifyAccount)
router.post("/activate", authLimiter, customerController.activateAccount)

router.post('/forgot-password', authLimiter, customerController.forgotPassword);
router.post('/reset-password', authLimiter, customerController.resetPassword);

// MFA + first-login password change (mobile customer)
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);
router.post('/mfa/setup', verifyToken(), mfaController.setup('Customer'));
router.post('/mfa/enable', verifyToken(), mfaController.enable('Customer'));
router.post('/mfa/disable', verifyToken(), mfaController.disable('Customer'));
router.post('/change-password', verifyToken(), passwordController.changePassword('Customer'));
// Portal-only: the mobile app never lists customers, and a mobile actor token
// would resolve to no requester company (global scope) here.
router.get('/stats',verifyToken(), requirePortalUser, requirePermission('VIEW_CUSTOMERS'), customerController.getCustomerStats)
router.get("/",verifyToken(), requirePortalUser, requirePermission('VIEW_CUSTOMERS'), customerController.getAllCustomers)
router.get('/get-garages/:claimId',verifyToken(), customerController.getGarage)
router.put('/updateCustomer/:customerId',verifyToken(), customerController.updateCustomer)
router.delete('/:customerId', verifyToken(), requirePortalUser, requirePermission('DELETE_CUSTOMER'), customerController.deleteCustomer)
router.get('/myClaims/:customerId',verifyToken(), customerController.getCustomerClaims)
// Mobile insurer selector: list this person's insurers / swap the session to
// their record at another insurer (returns { user, tokens } like login).
router.get('/my-companies', verifyToken(), customerController.getMyCompanies)
router.post('/switch-company', verifyToken(), customerController.switchCompany)
router.patch('/:id/fcm-token', verifyToken(), customerController.updateFcmToken)
router.patch('/request-deletion', customerController.requestAccountDeletion)

module.exports = router;