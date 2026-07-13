const supplierController = require("../controllers/supplier.controller")
const express =require("express")
const verifyToken = require("../middlewheres/verifyToken");
const authLimiter = require("../middlewheres/authLimiter");
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");

const router = express.Router();



router.post('/create',supplierController.createSupplier)
router.post('/login', authLimiter, supplierController.login)
router.post('/forgot-password', authLimiter, supplierController.forgotPassword);
router.post('/reset-password', authLimiter, supplierController.resetPassword);

// MFA + first-login password change (mobile supplier)
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);
router.post('/mfa/setup', verifyToken(), mfaController.setup('Supplier'));
router.post('/mfa/enable', verifyToken(), mfaController.enable('Supplier'));
router.post('/mfa/disable', verifyToken(), mfaController.disable('Supplier'));
router.post('/change-password', verifyToken(), passwordController.changePassword('Supplier'));
router.get('/',verifyToken(), supplierController.getAllSuppliers)
router.get('/claimsInGarage',verifyToken(), supplierController.getAllClaimsInGarage)
router.post('/partsDelivered/:claimId',verifyToken(), supplierController.repairPartsDelivered)
router.delete('/delete/:id',verifyToken(), supplierController.deleteSupplier)
router.get('/:id',verifyToken(), supplierController.getSupplierById)
router.post('/supplyBid/:claimId',verifyToken(), supplierController.submitBidForSupply)
router.put('/:id',verifyToken(), supplierController.updateSupplier)
router.get('/myBids/:supplierId',verifyToken(), supplierController.getMyBidHistory)
router.patch('/:id/fcm-token', verifyToken(), supplierController.updateFcmToken)

module.exports = router;