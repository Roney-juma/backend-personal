const claimController = require("../controllers/claim.controllers")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();

router.use(verifyToken())

router.post('/create', claimController.createClaim)
router.get('/', claimController.getClaims)
router.get('/count', claimController.countClaimsByStatus)
router.get('/total-cost', claimController.getClaimsTotalCost)
router.post('/generate-claim-link', claimController.generateClaimLinkController);
router.post('/file-claim/:token', claimController.fileClaim);
router.patch('/approve/:id', claimController.approveClaim)
router.delete('/delete/:id', claimController.deleteClaim)
router.patch('/reject/:id', claimController.rejectClaim)
router.get('/awarded', claimController.getAwardedClaims)
router.get('/bids/:id', claimController.getBidsByClaim)
router.get('/garageBids/:id', claimController.getGarageBidsByClaim)
router.get('/assessed', claimController.garageFindsAssessedClaimsForRepair);
router.get('/assessed/:id', claimController.getAssessedClaimById);
// router.get('/assessed/repair/:id', claimController.getAssessedRepairClaimById);
router.get('/supplier-bids/:claimId', claimController.getSupplierBidsForClaim)
router.post('/acceptSupplier/:claimId/:bidId', claimController.acceptSupplierBid)
router.post('/awardClaimToGarage/:claimId/:garageId', claimController.awardClaimToGarage);
router.post('/rejectAssessorBid/:id', claimController.rejectAssessorBid);
router.post('/rejectGarageBid/:id', claimController.rejectGarageBid);
router.post('/awardSupplier/:claimId/:bidId', claimController.awardSupplierBid);
router.post('/rejectSupplierBid/:claimId/:bidId', claimController.rejectSupplierBid);

// Self-repair routes — must be declared before /:id to avoid route shadowing
router.get('/self-repair', claimController.getSelfRepairClaims);
router.post('/self-repair/opt-in/:id', claimController.optInSelfRepair);
router.patch('/self-repair/submit/:id', claimController.submitSelfRepair);
router.patch('/self-repair/approve/:id', claimController.approveSelfRepair);
router.patch('/self-repair/reject/:id', claimController.rejectSelfRepair);
router.patch('/self-repair/pay/:id', claimController.markSelfRepairPaid);

// Wildcard param routes last — must come after all static-segment routes
router.get('/:id', claimController.getClaimById)
router.post('/awardClaim/:id', claimController.awardClaim)
router.post('/awardGarage/:id', claimController.awardBidToGarage)
router.patch('/:id', claimController.updateClaimById)



module.exports = router;