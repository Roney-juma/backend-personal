const claimController = require("../controllers/claim.controllers")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");
const requirePortalUser = require("../middlewheres/requirePortalUser");

const router = express.Router();

router.post('/file-claim/:token', claimController.fileClaim);

router.use(verifyToken())

// Admin-only decisions (approve/reject/award/pay/fraud) are portal-gated: a
// mobile actor token resolves to no requester company, so without the gate it
// would reach these handlers with global scope. Actor- and customer-facing
// routes (create, resubmit, self-repair opt-in/submit, glass complete, reads
// used by the app) stay open to any authenticated token.
router.post('/create', claimController.createClaim)
// Claim lists/aggregates are portal features — actor apps use their own
// id-scoped feeds. Portal-gating keeps legacy actor tokens (no company claim,
// which would resolve to global scope) away from cross-tenant lists.
router.get('/', requirePortalUser, claimController.getClaims)
router.get('/count', requirePortalUser, claimController.countClaimsByStatus)
router.get('/total-cost', requirePortalUser, claimController.getClaimsTotalCost)
router.post('/generate-claim-link', requirePortalUser, claimController.generateClaimLinkController);
router.post('/generate-ai-claim-link', requirePortalUser, claimController.generateAiClaimLinkController);
router.patch('/approve/:id', requirePortalUser, claimController.approveClaim)
router.delete('/delete/:id', requirePortalUser, claimController.deleteClaim)
router.patch('/reject/:id', requirePortalUser, claimController.rejectClaim)
router.get('/awarded', requirePortalUser, claimController.getAwardedClaims)
router.get('/bids/:id', claimController.getBidsByClaim)
router.get('/garageBids/:id', claimController.getGarageBidsByClaim)
router.get('/assessed', claimController.garageFindsAssessedClaimsForRepair);
router.get('/assessed/:id', claimController.getAssessedClaimById);
// router.get('/assessed/repair/:id', claimController.getAssessedRepairClaimById);
router.get('/supplier-bids/:claimId', claimController.getSupplierBidsForClaim)
router.post('/acceptSupplier/:claimId/:bidId', requirePortalUser, claimController.acceptSupplierBid)
router.post('/awardClaimToGarage/:claimId/:garageId', requirePortalUser, claimController.awardClaimToGarage);
router.post('/rejectAssessorBid/:id', requirePortalUser, claimController.rejectAssessorBid);
router.post('/rejectGarageBid/:id', requirePortalUser, claimController.rejectGarageBid);
router.post('/awardSupplier/:claimId/:bidId', requirePortalUser, claimController.awardSupplierBid);
router.post('/rejectSupplierBid/:claimId/:bidId', requirePortalUser, claimController.rejectSupplierBid);

router.patch('/resubmit/:id', claimController.resubmitRejectedClaim);

// Self-repair routes — must be declared before /:id to avoid route shadowing
router.get('/self-repair', requirePortalUser, claimController.getSelfRepairClaims);
router.post('/self-repair/opt-in/:id', claimController.optInSelfRepair);
router.patch('/self-repair/submit/:id', claimController.submitSelfRepair);
router.patch('/self-repair/call-re-assessment/:id', claimController.callForSelfRepairReAssessment);
router.patch('/self-repair/re-assess/:id', claimController.reAssessSelfRepair);
router.patch('/self-repair/approve/:id', requirePortalUser, claimController.approveSelfRepair);
router.patch('/self-repair/reject/:id', requirePortalUser, claimController.rejectSelfRepair);
router.patch('/self-repair/pay-deposit/:id', requirePortalUser, claimController.payInitialDeposit);
router.patch('/self-repair/pay-settlement/:id', requirePortalUser, claimController.payFinalSettlement);
// Pays the outstanding balance (final settlement) and closes the claim — alias used by the client.
router.patch('/self-repair/pay/:id', requirePortalUser, claimController.payFinalSettlement);

// Re-assessment completion (admin)
router.patch('/complete-claim/:id', requirePortalUser, claimController.completeReAssessment);

// Glass / motor glass claim routes — before wildcard /:id
router.get('/glass', requirePortalUser, claimController.getGlassClaims);
router.patch('/glass/approve/:id', requirePortalUser, claimController.approveGlassClaim);
router.post('/glass/assign-supplier/:id', requirePortalUser, claimController.assignGlassSupplier);
router.patch('/glass/complete/:id', claimController.completeGlassRepair);

// Fraud detection — admin can manually re-run the automated check on any claim
router.post('/fraud-check/:id', requirePortalUser, claimController.runFraudCheck);

// AI analysis — full signal breakdown for a claim (fetches AiAnalysis doc)
router.get('/ai-analysis/:id', claimController.getAiAnalysis);

// Vehicle continuity — cross-stage "same car?" verdicts (one per stage)
router.get('/continuity/:id', claimController.getVehicleContinuity);

// Wildcard param routes last — must come after all static-segment routes
router.get('/:id', claimController.getClaimById)
router.post('/awardClaim/:id', claimController.awardClaim)
router.post('/awardGarage/:id', claimController.awardBidToGarage)
router.patch('/:id', claimController.updateClaimById)



module.exports = router;