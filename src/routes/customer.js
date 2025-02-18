
const express = require("express");
const customerController = require("../controllers/customerController")
const verifyToken = require("../middlewheres/verifyToken");
const router = express.Router();



router.post("/register", customerController.createCustomer)
router.post("/login", customerController.login)
router.post('/reset-password', customerController.resetPassword);
router.get('/stats', customerController.getCustomerStats)
router.get("/", customerController.getAllCustomers)
router.get('/get-garages/:claimId', customerController.getGarage)
router.put('/updateCustomer/:customerId', customerController.updateCustomer)
router.get('/myClaims/:customerId', customerController.getCustomerClaims)

module.exports = router;