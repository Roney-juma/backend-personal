const claimController = require("../controllers/claim.controllers")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();


router.post('/create', claimController.createClaim)
router.get('/', claimController.getClaims)
router.get('/count', claimController.countClaimsByStatus)
router.get('/total-cost', claimController.getClaimsTotalCost)
router.post('/generate-claim-link', claimController.generateClaimLinkController);
router.post('/file-claim/:token', claimController.fileClaim);
router.patch('/approve/:id', claimController.approveClaim)
router.delete('/delete/:id', claimController.deleteClaim)
router.patch('/reject/:id', claimController.rejectClaim)
router.get('/:id', claimController.getClaimById)
router.patch('/:id', claimController.updateClaimById)
router.post('/awardClaim/:id', claimController.awardClaim)
router.post('/awardGarage/:id', claimController.awardBidToGarage)
router.get('/awarded', claimController.getAwardedClaims)
router.get('/bids/:id', claimController.getBidsByClaim)
router.get('/garageBids/:id', claimController.getGarageBidsByClaim)
router.get('/assessed', claimController.garageFindsAssessedClaimsForRepair);
router.get('/assessed/:id', claimController.getAssessedClaimById);
// router.get('/assessed/repair/:id', claimController.getAssessedRepairClaimById);
router.get('/supplier-bids/:claimId', claimController.getSupplierBidsForClaim)
router.post('/acceptSupplier/:claimId/:bidId', claimController.acceptSupplierBid)





module.exports = router;