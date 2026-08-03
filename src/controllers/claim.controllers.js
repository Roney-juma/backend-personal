const claimService = require('../service/claim.service');
const assessorService = require('../service/assessor.service');
const logger = require('../middlewheres/logger');
const { analyseClaimFraud, applyFraudAnalysis, notifyAdminFraudAlert } = require('../service/fraud.service');
const Claim = require('../models/claim.model');
const AiAnalysis = require('../models/aiAnalysis.model');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');

// Resolve the requester's tenant for claim access. Portal admins carry a
// company claim (or resolve via the legacy DB fallback); AVE staff resolve to
// null → global scope. Mobile actor tokens (Customer/Garage/Assessor/Supplier)
// also carry their insurer's company claim now, so they are scoped to their
// own tenant too — an actor must never see another insurer's claims. Legacy
// actor tokens without the claim resolve to null (expire within 2 days).
const portalCompany = async (req) => {
  return getRequesterCompany(req);
};

// Ownership guard for portal reads/mutations on a single claim. Responds 404 on a
// cross-tenant claim so foreign ids are indistinguishable from missing ones.
// Returns false when the response has already been sent.
const ensureClaimInCompany = async (req, res, claimId) => {
  const company = await portalCompany(req);
  if (!company) return true;
  const claim = await Claim.findById(claimId).select('company').lean();
  if (!claim || !belongsToCompany(claim.company, company)) {
    res.status(404).json({ message: 'Claim not found' });
    return false;
  }
  return true;
};

const generateClaimLinkController = async (req, res) => {
  const { email } = req.body;

  try {
    // Company-scoped admins can only generate links for their own customers.
    const claimLink = await claimService.generateClaimLink(email, await portalCompany(req));
    res.status(200).json({ message: 'Claim link generated successfully', claimLink });

  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
};

const generateAiClaimLinkController = async (req, res) => {
  const { email } = req.body;

  try {
    const claimLink = await claimService.generateAiClaimLink(email, await portalCompany(req));
    res.status(200).json({ message: 'AI claim link generated successfully', claimLink });

  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
};


const fileClaim = async (req, res) => {
  const { token } = req.params;
  const { incidentDetails, vehiclesInvolved, drivers, passengers, damage, description, damagedParts, injuries, witnesses, policeReport, supportingDocuments, additionalInfo } = req.body;

  try {
    const claimDetails = {
      incidentDetails,
      vehiclesInvolved,
      drivers,
      passengers,
      damage,
      description,
      damagedParts,
      injuries,
      witnesses,
      policeReport,
      supportingDocuments,
      additionalInfo
    };
    const newClaim = await claimService.fileClaimService(token, claimDetails, req);

    res.status(201).json({ message: 'Claim filed successfully', claim: newClaim });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};


// Create a new claim
const createClaim = async (req, res) => {
  try {
    const claim = await claimService.createClaim(req.body, req);
    res.status(201).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all claims
const getClaims = async (req, res) => {
  try {
    const claims = await claimService.getClaims(await portalCompany(req), { page: req.query.page, limit: req.query.limit });
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get claims by customer ID
const getClaimsByCustomer = async (req, res) => {
  try {
    const claims = await claimService.getClaimsByCustomer(req.params.customerId);
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Approve a claim
const approveClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.approveClaim(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete a claim
const deleteClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.deleteClaim(req.params.id, req);
    res.status(200).json({ message: 'Claim deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Reject a claim
const rejectClaim = async (req, res) => {
  try {
    const { rejectionReason } = req.body;
    if (!rejectionReason) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.rejectClaim(req.params.id, rejectionReason, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get a specific claim by ID
const getClaimById = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.getClaimById(req.params.id);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Award a claim to an assessor
const awardClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.awardClaim(req.params.id, req.body.bidId, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Award a bid to a garage
const awardBidToGarage = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.awardBidToGarage(req.params.id, req.body.bidId, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get awarded claims
const getAwardedClaims = async (req, res) => {
  try {
    const claims = await claimService.getAwardedClaims(await portalCompany(req));
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get bids by claim
const getBidsByClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const bids = await claimService.getBidsByClaim(req.params.id);
    res.status(200).json(bids);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get garage bids by claim
const getGarageBidsByClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const bids = await claimService.getGarageBidsByClaim(req.params.id);
    res.status(200).json(bids);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Garage finds assessed claims for repair
const garageFindsAssessedClaimsForRepair = async (req, res) => {
  try {
    const claims = await claimService.garageFindsAssessedClaimsForRepair(await portalCompany(req));
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get assessed claim by ID
const getAssessedClaimById = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.getAssessedClaimById(req.params.id);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get assessed claims by garage
const getAssessedClaimsByGarage = async (req, res) => {
  try {
    const claims = await claimService.getAssessedClaimsByGarage(req.params.garageId);
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all supplier bids for a claim
const getSupplierBidsForClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.claimId))) return;
    const bids = await claimService.getSupplierBidsForClaim(req.params.claimId);
    res.status(200).json(bids);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Accept a supplier bid
const acceptSupplierBid = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.claimId))) return;
    const bid = await claimService.acceptSupplierBid(req.params.claimId, req.params.bidId, req);
    res.status(200).json(bid);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update claim
const updateClaimById = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const updatedClaim = await claimService.updateClaim(req.params.id, req.body);
    if (!updatedClaim) return res.status(404).json({ message: 'Claim not found' });
    res.status(200).json(updatedClaim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
// Count claims by status
const countClaimsByStatus = async (req, res) => {
  try {
    const count = await claimService.countClaimsByStatus(await portalCompany(req));
    res.status(200).json(count);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

const getClaimsTotalCost = async (req, res) => {
  try {
    const totalCost = await claimService.getPaymentTotals(await portalCompany(req));
    res.status(200).json(totalCost);
  }
  catch (error) {
    res.status(500).json({ message: error.message });
  }
}
const awardClaimToGarage = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.claimId))) return;
    const claim = await claimService.awardClaimToGarage(req.params.claimId, req.params.garageId);
    res.status(200).json(claim);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// Reject a specific assessor bid
const rejectAssessorBid = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.rejectAssessorBid(req.params.id, req.body.bidId, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Reject a specific garage bid
const rejectGarageBid = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.rejectGarageBid(req.params.id, req.body.bidId, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Award a supplier bid
const awardSupplierBid = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.claimId))) return;
    const bid = await claimService.awardSupplierBid(req.params.claimId, req.params.bidId, req);
    res.status(200).json(bid);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Reject a specific supplier bid
const rejectSupplierBid = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.claimId))) return;
    const bid = await claimService.rejectSupplierBid(req.params.claimId, req.params.bidId, req);
    res.status(200).json(bid);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const optInSelfRepair = async (req, res) => {
  try {
    const { selfRepair } = req.body;
    const claim = await claimService.optInSelfRepair(req.params.id, selfRepair, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const submitSelfRepair = async (req, res) => {
  try {
    const { bankingDetails } = req.body;
    if (!bankingDetails) return res.status(400).json({ message: 'bankingDetails is required' });
    const claim = await claimService.submitSelfRepair(req.params.id, { bankingDetails }, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const callForSelfRepairReAssessment = async (req, res) => {
  try {
    const claim = await claimService.callForSelfRepairReAssessment(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const reAssessSelfRepair = async (req, res) => {
  try {
    const { notes, recommendedAmount } = req.body;
    const claim = await claimService.reAssessSelfRepair(req.params.id, { notes, recommendedAmount }, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const approveSelfRepair = async (req, res) => {
  try {
    const { totalAwardedAmount, depositPercentage } = req.body;
    if (!totalAwardedAmount) return res.status(400).json({ message: 'totalAwardedAmount is required' });
    if (!depositPercentage) return res.status(400).json({ message: 'depositPercentage is required' });
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.approveSelfRepair(req.params.id, { totalAwardedAmount, depositPercentage }, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const rejectSelfRepair = async (req, res) => {
  try {
    const { rejectionReason } = req.body;
    if (!rejectionReason) return res.status(400).json({ message: 'rejectionReason is required' });
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.rejectSelfRepair(req.params.id, { rejectionReason }, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const payInitialDeposit = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.payInitialDeposit(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const payFinalSettlement = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.payFinalSettlement(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const completeReAssessment = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await assessorService.completeRepair(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    logger.error(`Error completing re-assessment: ${error.message}`);
    res.status(500).json({ message: error.message });
  }
};

const getSelfRepairClaims = async (req, res) => {
  try {
    const claims = await claimService.getSelfRepairClaims(await portalCompany(req));
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const resubmitRejectedClaim = async (req, res) => {
  try {
    const claim = await claimService.resubmitRejectedClaim(req.params.id, req.body, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const approveGlassClaim = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.approveGlassClaim(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const assignGlassSupplier = async (req, res) => {
  try {
    const { supplierId, appointmentDate, notes } = req.body;
    if (!supplierId) return res.status(400).json({ message: 'supplierId is required' });
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.assignGlassSupplier(req.params.id, { supplierId, appointmentDate, notes }, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

const completeGlassRepair = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const claim = await claimService.completeGlassRepair(req.params.id, req);
    res.status(200).json(claim);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getGlassClaims = async (req, res) => {
  try {
    const claims = await claimService.getGlassClaims(await portalCompany(req));
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAiAnalysis = async (req, res) => {
  try {
    const claim = await Claim.findById(req.params.id).select('ai company').lean();
    if (!claim) return res.status(404).json({ message: 'Claim not found' });
    if (!belongsToCompany(claim.company, await portalCompany(req))) {
      return res.status(404).json({ message: 'Claim not found' });
    }
    if (!claim.ai?.analysisId) return res.status(200).json(null);
    const analysis = await AiAnalysis.findById(claim.ai.analysisId).lean();
    res.status(200).json(analysis);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getVehicleContinuity = async (req, res) => {
  try {
    if (!(await ensureClaimInCompany(req, res, req.params.id))) return;
    const analyses = await AiAnalysis.find({ claimId: req.params.id, kind: 'vehicle_continuity' })
      .sort({ createdAt: -1 })
      .lean();
    // One entry per stage — the most recent supersedes earlier re-submissions.
    const latestByStage = {};
    for (const a of analyses) {
      if (a.stage && !latestByStage[a.stage]) latestByStage[a.stage] = a;
    }
    res.status(200).json(Object.values(latestByStage));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const runFraudCheck = async (req, res) => {
  try {
    const claim = await Claim.findById(req.params.id);
    if (!claim) return res.status(404).json({ message: 'Claim not found' });
    if (!belongsToCompany(claim.company, await portalCompany(req))) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    const analysis = await analyseClaimFraud(claim);
    applyFraudAnalysis(claim, analysis);
    await claim.save();

    if (analysis.riskLevel !== 'low') {
      await notifyAdminFraudAlert(claim, analysis);
    }

    res.status(200).json({ riskScore: analysis.score, riskLevel: analysis.riskLevel, flags: analysis.flags });
  } catch (error) {
    logger.error(`Error running fraud check: ${error.message}`);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  generateClaimLinkController,
  generateAiClaimLinkController,
  fileClaim,
  createClaim,
  getClaims,
  getClaimsByCustomer,
  approveClaim,
  deleteClaim,
  rejectClaim,
  getClaimById,
  awardClaim,
  awardBidToGarage,
  getAwardedClaims,
  getBidsByClaim,
  getGarageBidsByClaim,
  garageFindsAssessedClaimsForRepair,
  getAssessedClaimById,
  getAssessedClaimsByGarage,
  getSupplierBidsForClaim,
  acceptSupplierBid,
  updateClaimById,
  countClaimsByStatus,
  getClaimsTotalCost,
  awardClaimToGarage,
  rejectAssessorBid,
  rejectGarageBid,
  awardSupplierBid,
  rejectSupplierBid,
  optInSelfRepair,
  submitSelfRepair,
  callForSelfRepairReAssessment,
  reAssessSelfRepair,
  approveSelfRepair,
  rejectSelfRepair,
  payInitialDeposit,
  payFinalSettlement,
  completeReAssessment,
  getSelfRepairClaims,
  resubmitRejectedClaim,
  approveGlassClaim,
  assignGlassSupplier,
  completeGlassRepair,
  getGlassClaims,
  runFraudCheck,
  getAiAnalysis,
  getVehicleContinuity,
};
