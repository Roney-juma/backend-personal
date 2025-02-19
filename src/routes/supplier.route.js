const supplierController = require("../controllers/supplier.controller")
const express =require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();



router.post('/create',supplierController.createSupplier)
router.post('/login',supplierController.login)
router.post('/reset-password', supplierController.resetPassword);
router.get('/',verifyToken(), supplierController.getAllSuppliers)
router.get('/claimsInGarage',verifyToken(), supplierController.getAllClaimsInGarage)
router.post('/partsDelivered/:claimId',verifyToken(), supplierController.repairPartsDelivered)
router.delete('/delete/:id',verifyToken(), supplierController.deleteSupplier)
router.get('/:id',verifyToken(), supplierController.getSupplierById)
router.post('/supplyBid/:claimId',verifyToken(), supplierController.submitBidForSupply)
router.put('/:id',verifyToken(), supplierController.updateSupplier)
router.get('/myBids/:supplierId',verifyToken(), supplierController.getMyBidHistory)


module.exports = router;