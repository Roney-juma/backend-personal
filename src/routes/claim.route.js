const claimController = require("../controllers/claim.controllers")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");
const requirePortalUser = require("../middlewheres/requirePortalUser");
const requirePermission = require("../middlewheres/requirePermission");
const verifyClaimToken = require("../middlewheres/verifyClaimToken");

const router = express.Router();

router.get('/file-claim/:token/validate', verifyClaimToken, claimController.validateClaimLink);
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
// NOTE: the assessor mobile app uses this as its claims feed — must stay open
// to actor tokens. Tenant scoping happens in the controller (company claim).
router.get('/', claimController.getClaims)
router.get('/count', requirePortalUser, requirePermission('VIEW_CLAIM_ANALYTICS'), claimController.countClaimsByStatus)
router.get('/total-cost', requirePortalUser, requirePermission('VIEW_CLAIM_ANALYTICS'), claimController.getClaimsTotalCost)
router.post('/generate-claim-link', requirePortalUser, requirePermission('GENERATE_CLAIM_LINK'), claimController.generateClaimLinkController);
router.post('/generate-ai-claim-link', requirePortalUser, requirePermission('GENERATE_CLAIM_LINK'), claimController.generateAiClaimLinkController);
router.patch('/approve/:id', requirePortalUser, requirePermission('APPROVE_CLAIM'), claimController.approveClaim)
router.delete('/delete/:id', requirePortalUser, requirePermission('DELETE_CLAIM'), claimController.deleteClaim)
router.patch('/reject/:id', requirePortalUser, requirePermission('REJECT_CLAIM'), claimController.rejectClaim)
router.get('/awarded', requirePortalUser, requirePermission('VIEW_CLAIMS'), claimController.getAwardedClaims)
router.get('/bids/:id', claimController.getBidsByClaim)
router.get('/garageBids/:id', claimController.getGarageBidsByClaim)
router.get('/assessed', claimController.garageFindsAssessedClaimsForRepair);
router.get('/assessed/:id', claimController.getAssessedClaimById);
// router.get('/assessed/repair/:id', claimController.getAssessedRepairClaimById);
router.get('/supplier-bids/:claimId', claimController.getSupplierBidsForClaim)
router.post('/acceptSupplier/:claimId/:bidId', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.acceptSupplierBid)
// NOTE: the customer mobile app uses this to pick a garage for their own claim.
// Deliberately NOT portal-gated despite the name: this is the CUSTOMER choosing
// their repairer from the mobile app (customer_service.dart → awardClaimToGarage).
// Gating it on AWARD_CLAIM like its portal-side namesakes below would lock every
// policyholder out of picking a garage.
router.post('/awardClaimToGarage/:claimId/:garageId', claimController.awardClaimToGarage);
router.post('/rejectAssessorBid/:id', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.rejectAssessorBid);
router.post('/rejectGarageBid/:id', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.rejectGarageBid);
router.post('/awardSupplier/:claimId/:bidId', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.awardSupplierBid);
router.post('/rejectSupplierBid/:claimId/:bidId', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.rejectSupplierBid);

router.patch('/resubmit/:id', claimController.resubmitRejectedClaim);

// Self-repair routes — must be declared before /:id to avoid route shadowing
router.get('/self-repair', requirePortalUser, requirePermission('VIEW_SELF_REPAIR'), claimController.getSelfRepairClaims);
router.post('/self-repair/opt-in/:id', claimController.optInSelfRepair);
router.patch('/self-repair/submit/:id', claimController.submitSelfRepair);
router.patch('/self-repair/call-re-assessment/:id', claimController.callForSelfRepairReAssessment);
router.patch('/self-repair/re-assess/:id', claimController.reAssessSelfRepair);
router.patch('/self-repair/approve/:id', requirePortalUser, requirePermission('APPROVE_SELF_REPAIR'), claimController.approveSelfRepair);
router.patch('/self-repair/reject/:id', requirePortalUser, requirePermission('REJECT_SELF_REPAIR'), claimController.rejectSelfRepair);
router.patch('/self-repair/pay-deposit/:id', requirePortalUser, requirePermission('PAY_SELF_REPAIR'), claimController.payInitialDeposit);
router.patch('/self-repair/pay-settlement/:id', requirePortalUser, requirePermission('PAY_SELF_REPAIR'), claimController.payFinalSettlement);
// Pays the outstanding balance (final settlement) and closes the claim — alias used by the client.
router.patch('/self-repair/pay/:id', requirePortalUser, requirePermission('PAY_SELF_REPAIR'), claimController.payFinalSettlement);

// Re-assessment completion (admin)
router.patch('/complete-claim/:id', requirePortalUser, requirePermission('COMPLETE_CLAIM'), claimController.completeReAssessment);

// Glass / motor glass claim routes — before wildcard /:id
router.get('/glass', requirePortalUser, requirePermission('VIEW_GLASS_CLAIMS'), claimController.getGlassClaims);
router.patch('/glass/approve/:id', requirePortalUser, requirePermission('APPROVE_GLASS_CLAIM'), claimController.approveGlassClaim);
router.post('/glass/assign-supplier/:id', requirePortalUser, requirePermission('ASSIGN_GLASS_SUPPLIER'), claimController.assignGlassSupplier);
// Called only from the portal's Glass Claims screen — not by the mobile app or
// the partner portal — so it belongs with the other glass decisions above.
router.patch('/glass/complete/:id', requirePortalUser, requirePermission('COMPLETE_GLASS_CLAIM'), claimController.completeGlassRepair);

// Fraud detection — admin can manually re-run the automated check on any claim
router.post('/fraud-check/:id', requirePortalUser, requirePermission('FLAG_FRAUD'), claimController.runFraudCheck);

// AI analysis — full signal breakdown for a claim (fetches AiAnalysis doc)
router.get('/ai-analysis/:id', claimController.getAiAnalysis);

// Vehicle continuity — cross-stage "same car?" verdicts (one per stage)
router.get('/continuity/:id', claimController.getVehicleContinuity);

// Wildcard param routes last — must come after all static-segment routes
router.get('/:id', claimController.getClaimById)
// Awarding is the decision that commits money, and both of these are called only
// from the insurer portal. They were the two the original RBAC pass missed: every
// sibling — rejectAssessorBid, rejectGarageBid, awardSupplier, rejectSupplierBid,
// acceptSupplier — already required AWARD_CLAIM, so REJECTING a bid was gated
// while AWARDING one was not.
router.post('/awardClaim/:id', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.awardClaim)
router.post('/awardGarage/:id', requirePortalUser, requirePermission('AWARD_CLAIM'), claimController.awardBidToGarage)
router.patch('/:id', requirePortalUser, requirePermission('UPDATE_CLAIM'), claimController.updateClaimById)



module.exports = router;