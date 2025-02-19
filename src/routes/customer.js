
const express = require("express");
const customerController = require("../controllers/customerController")
const verifyToken = require("../middlewheres/verifyToken");
const router = express.Router();



router.post("/register", customerController.createCustomer)
router.post("/login", customerController.login)
router.post('/reset-password', customerController.resetPassword);
router.get('/stats',verifyToken(), customerController.getCustomerStats)
router.get("/",verifyToken(), customerController.getAllCustomers)
router.get('/get-garages/:claimId',verifyToken(), customerController.getGarage)
router.put('/updateCustomer/:customerId',verifyToken(), customerController.updateCustomer)
router.get('/myClaims/:customerId',verifyToken(), customerController.getCustomerClaims)

module.exports = router;