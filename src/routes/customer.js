// const customerController = require("../controllers/customerController")
// const express = require("express")

// const router = express.Router()

// router.get("/", customerController.welcome)
// router.post("/register", customerController.createCustomer)


// module.exports = router
const express = require("express");
const customerController = require("../controllers/customerController")
const router = express.Router();



router.post("/register", customerController.createCustomer)
router.post("/login", customerController.login)
router.post('/reset-password', customerController.resetPassword);
router.get("/", customerController.getAllCustomers)
router.get('/myClaims/:customerId', customerController.getCustomerClaims)

module.exports = router;