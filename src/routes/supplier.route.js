const supplierController = require("../controllers/supplier.controller")
const express =require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();


router.post('/create',supplierController.createSupplier)
router.post('/login',supplierController.login)
router.post('/reset-password', supplierController.resetPassword);
router.get('/',supplierController.getAllSuppliers)
router.get('/claimsInGarage',supplierController.getAllClaimsInGarage)
router.post('/partsDelivered/:claimId',supplierController.repairPartsDelivered)
router.delete('/delete/:id', supplierController.deleteSupplier)
router.get('/:id', supplierController.getSupplierById)
router.post('/supplyBid/:claimId',supplierController.submitBidForSupply)
router.put('/:id',supplierController.updateSupplier)
router.get('/myBids/:supplierId',supplierController.getMyBidHistory)


module.exports = router;