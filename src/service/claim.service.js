const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const { writeAuditLog } = require('../utils/auditHelper');
const SupplyBid = require('../models/supplyBids.model');
const Supplier = require('../models/supplier.model');
const notificationService = require('./notification.service');
const emailService = require('./email.service');
const ClaimToken = require('../models/claimToken.model');
const crypto = require('crypto');
const logger = require('../middlewheres/logger');

const getGarageBidRankingData = (bid) => {
  const rating = bid?.garageDetails?.ratings?.averageRating ?? bid?.ratings ?? 0;
  const pendingWork = bid?.garageDetails?.pendingWork ?? Number.MAX_SAFE_INTEGER;
  const totalCost = bid?.totalCost ?? Number.MAX_SAFE_INTEGER;

  return {
    rating: Number.isFinite(rating) ? rating : 0,
    pendingWork: Number.isFinite(pendingWork) ? pendingWork : Number.MAX_SAFE_INTEGER,
    totalCost: Number.isFinite(totalCost) ? totalCost : Number.MAX_SAFE_INTEGER,
  };
};

const selectBestGarageBid = (garageBids = []) => {
  if (!garageBids.length) return null;

  return garageBids.reduce((bestBid, currentBid) => {
    if (!bestBid) return currentBid;

    const current = getGarageBidRankingData(currentBid);
    const best = getGarageBidRankingData(bestBid);

    if (current.rating > best.rating) return currentBid;
    if (current.rating < best.rating) return bestBid;

    if (current.pendingWork < best.pendingWork) return currentBid;
    if (current.pendingWork > best.pendingWork) return bestBid;

    if (current.totalCost < best.totalCost) return currentBid;
    return bestBid;
  }, null);
};

const generateClaimLink = async (email) => {
  try {
    const customer = await Customer.findOne({ email });

    if (!customer) {
      return { error: 'Customer not found' };
    }
    const token = crypto.randomBytes(20).toString('hex');
    const customerId = customer._id;


    const claimToken = new ClaimToken({
      customerId,
      token,
    });

    await claimToken.save();

    const claimLink = `https://avics.aveafrica.com/file-claim/${token}`;
    await emailService.sendEmailNotification(
      email,
      'File a claim here',
      `Dear ${customer.firstName},\n\nClick this link to file a claim: ${claimLink}\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
    return claimLink;
  } catch (error) {
    logger.error('Failed to generate claim link: %s', error.message);
    return { error: 'Failed to generate claim link' };
  }
};


// File the claim for Web

const fileClaimService = async (token, claimDetails, req) => {
  try {
    const claimToken = await ClaimToken.findOne({ token });

    if (!claimToken) {
      throw new Error('Invalid token');
    }
    if (claimToken.used) {
      throw new Error('This link has already been used');
    }
    claimToken.used = true;
    await claimToken.save();
    const customer = await Customer.findById(claimToken.customerId);

    if (!customer) {
      throw new Error('Customer not found');
    }
    const newClaim = new Claim({
      customerId: customer._id,
      claimant: {
        name: `${customer.firstName} ${customer.lastName}`,
        address: customer.address || 'Not Provided',
        phone: customer.phone,
        email: customer.email
      },
      ...claimDetails,
    });
    const start = Date.now();
    await newClaim.save();

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Claim',
      actionDescription: `Customer ${customer.firstName} ${customer.lastName} filed a new claim via token link`,
      resourceType: 'Claim',
      resourceId: newClaim._id,
      statusCode: 201,
      success: true,
      responseTimeMs: Date.now() - start,
      changes: { old: null, new: { customerId: customer._id, claimant: newClaim.claimant } },
    });
    if (newClaim.claimant.email) {
      await emailService.sendEmailNotification(
        newClaim.claimant.email,
        'Claim Submission Confirmation',
        `Dear ${newClaim.claimant.name},\n\nYour claim has been successfully submitted and is now being processed. Our team will review your claim and get back to you shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
      );
    }

    return newClaim;

  } catch (error) {
    throw new Error(error.message);
  }
};




// Create a new claim
const createClaim = async (data, req) => {
  try {
    const claimant = await Customer.findById(data.customerId);
    if (!claimant) {
      throw new Error('Customer not found');
    }
    claimant.name = `${claimant.firstName} ${claimant.lastName}`;
    data.claimant = {
      name: claimant.name,
      address: claimant.address,
      phone: claimant.phone,
      email: claimant.email,
    };
    const start = Date.now();
    const claim = new Claim(data);
    await claim.save();

    if (claimant.email) {
      await emailService.sendEmailNotification(
        claimant.email,
        'Claim Submission Confirmation',
        `Dear ${claimant.name},\n\nYour claim has been successfully submitted and is now being processed. Our team will review your claim and get back to you shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
      );
    }

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Claim',
      actionDescription: `Filed new claim for customer ${claimant.name}`,
      resourceType: 'Claim',
      resourceId: claim._id,
      statusCode: 201,
      success: true,
      responseTimeMs: Date.now() - start,
      changes: { old: null, new: { customerId: data.customerId, claimant: data.claimant } },
    });

    return claim;
  } catch (error) {
    return error.message;
  }
};

const getClaims = async () => {
  const claims = await Claim.find().sort({ createdAt: -1 });

  for (let claim of claims) {
    // Check if the claim is approved and has at least 3 assessor bids
    if (claim.bids.length >= 3 && claim.status === 'Approved') {
      const assessorBids = claim.bids.filter(bid => bid.bidderType === 'assessor');
      if (assessorBids.length === 0) continue;

      // Check if all assessor bids are pending and none have been awarded
      const hasAwardedBid = assessorBids.some(bid => bid.status === 'awarded');
      const allPending = assessorBids.every(bid => bid.status === 'pending');

      if (hasAwardedBid || !allPending) {
        continue; // Skip this claim if any bid is already awarded or not all are pending
      }

      let topRatedBid = null;
      let highestRating = -1;

      // Find the top-rated assessor bid
      for (let bid of assessorBids) {
        if (bid.assessorDetails && bid.assessorDetails.ratings.averageRating > highestRating) {
          highestRating = bid.assessorDetails.ratings.averageRating;
          topRatedBid = bid; // Update the top-rated bid
        }
      }

      // Award the top-rated assessor bid if found
      if (topRatedBid) {
        await awardClaim(claim._id, topRatedBid._id, null);
      }
    }

    // Auto-award garage bid once more than one garage has placed a bid
    if (claim.status === 'Garage') {
      const garageBids = claim.bids.filter(
        (bid) => bid.bidderType === 'garage' && bid.status === 'pending'
      );
      if (garageBids.length <= 3) continue;

      const topRatedGarageBid = selectBestGarageBid(garageBids);

      // Award the best garage bid (rating first, then lower pending work) if found
      if (topRatedGarageBid) {
        await awardBidToGarage(claim._id, topRatedGarageBid._id, null);
      }
    }
  }

  return claims;
};




// Get claims by customer ID
const getClaimsByCustomer = async (customerId) => {
  return await Claim.find({ customerId: customerId }).populate('customerId');
};

// Approve a claim
const approveClaim = async (id, req) => {
  const start = Date.now();
  const claim = await Claim.findByIdAndUpdate(id, { status: 'Approved' }, { new: true });
  if (!claim) {
    throw new Error('Claim not found');
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Approved claim ${id}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending' }, new: { status: 'Approved' } },
  });
  const claimant = claim.claimant;
  if (claimant && claimant.email) {
    await emailService.sendEmailNotification(
      claimant.email,
      'Claim Approval Notification',
      `Dear ${claimant.name},\n\nWe acknowledge receipt of your claim regarding vehicle registration number ${claim.vehiclesInvolved[0].licensePlate}.\n\nTo facilitate the claims process, an assessor will be appointed shortly to inspect and assess the vehicle. The assessment findings will enable us to determine the next steps and process your claim accordingly.\n\nOur team will keep you informed throughout the process and will contact you should any additional information be required.\n\nThank you for choosing Ave Insurance.\n\nKind regards,\n\nClaims Department\nAve Insurance`
      
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'claim_approved',
      title: 'Claim Approved',
      content: `Your claim (${claim.vehiclesInvolved[0]?.licensePlate || claim._id}) has been approved.`,
      claimId: claim._id,
    });
  }
  return claim;
};

// Delete a claim
const deleteClaim = async (id, req) => {
  try {
    const claim = await Claim.findById(id);
    if (!claim) {
      throw new Error('Claim not found');
    }

    const start = Date.now();
    const snapshot = claim.toObject();
    await claim.deleteOne();

    await writeAuditLog(req, {
      action: 'DELETE',
      module: 'Claim',
      actionDescription: `Deleted claim ${id}`,
      resourceType: 'Claim',
      resourceId: id,
      statusCode: 200,
      success: true,
      responseTimeMs: Date.now() - start,
      changes: { old: snapshot, new: null },
    });

    return claim;
  } catch (error) {
    logger.error('Error deleting claim: %s', error.message);
    throw error;
  }
};

// Reject a claim
const rejectClaim = async (id, rejectionReason, req) => {
  if (!rejectionReason || !rejectionReason.trim()) {
    throw new Error('Rejection reason is required');
  }

  const start = Date.now();
  const claim = await Claim.findByIdAndUpdate(
    id,
    { status: 'Rejected', rejectionReason: rejectionReason.trim() },
    { new: true }
  );
  if (!claim) {
    throw new Error('Claim not found');
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Rejected claim ${id}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: claim.status }, new: { status: 'Rejected', rejectionReason } },
  });

  const claimant = claim.claimant;
  if (claimant && claimant.email) {
    await emailService.sendEmailNotification(
      claimant.email,
      'Claim Rejection Notification',
      `Dear ${claimant.name},\n\nWe regret to inform you that your claim (Reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id}) has been rejected.\n\nReason for rejection: ${rejectionReason.trim()}\n\nIf you believe this decision is incorrect or would like to discuss further, please contact our support team.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'claim_rejected',
      title: 'Claim Rejected',
      content: `Your claim (${claim.vehiclesInvolved[0]?.licensePlate || claim._id}) has been rejected. Reason: ${rejectionReason.trim()}`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Get a specific claim by ID
const getClaimById = async (id) => {
  const claim = await Claim.findById(id)
    // .populate('bids.assessorId')
    .populate({ path: 'bids.assessorId', select: 'name email phone _id' })
    .populate({ path: 'bids.garageId', select: 'name email phone _id' });

  if (!claim) {
    throw new Error('Claim not found');
  }
  return claim;
};

// Award Bid to Assessor
const awardClaim = async (id, bidId, req) => {
  // Find the claim by ID
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');

  // Find the specific bid by bidId
  const bid = claim.bids.id(bidId);
  if (!bid || bid.status !== 'pending') throw new Error('Invalid bid');

  // Mark the specific bid as awarded
  bid.status = 'awarded';

  // Update claim status to 'Assessment'
  claim.status = 'Assessment';

  // Store awarded assessor details
  claim.awardedAssessor = {
    assessorId: bid.assessorId,
    awardedAmount: bid.amount,
    awardedDate: Date.now(),
  };

  // Mark all other assessor bids as rejected
  claim.bids.forEach(otherBid => {
    if (
      otherBid.bidderType === 'assessor' && // Only assessor bids
      otherBid._id.toString() !== bidId && // Exclude the awarded bid
      otherBid.status === 'pending' // Only pending bids
    ) {
      otherBid.status = 'rejected';
    }
  });


  await notificationService.createAndEmit({
    recipientId: bid.assessorId,
    recipientType: 'assessor',
    type: 'bid_awarded',
    title: 'Bid Awarded',
    content: `Your bid for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been awarded.`,
    claimId: claim._id,
  });
  const start = Date.now();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Awarded claim ${id} to assessor (bid ${bidId})`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Approved' }, new: { status: 'Assessment', awardedAssessor: claim.awardedAssessor } },
  });

  // Fetch the awarded assessor's details
  const assessor = await Assessor.findById(bid.assessorId);
  if (assessor && assessor.email) {
    // Send email notification to the awarded assessor
    await emailService.sendEmailNotification(
      assessor.email,
      'Claim Award Notification',
      `Dear ${assessor.name},\n\nCongratulations! You have been awarded the claim with ID: ${claim.vehiclesInvolved[0].licensePlate}. You are required to submit a report within 3 days.\n\nPlease ensure that the report is submitted on time to facilitate the next steps in the claims process.\n\nBest Regards,\nAdmin Team`
    );

    // Send email notification to the claimant
    if (claim.claimant && claim.claimant.email) {
      await emailService.sendEmailNotification(
        claim.claimant.email,
        'Assessor Visit Notification',
        `Dear ${claim.claimant.name},\n\nWe are pleased to inform you that your claim with ID: ${claim.vehiclesInvolved[0].licensePlate} has been awarded to an assessor. The assessor, ${assessor.name}, will be visiting to assess the state of your vehicle.\n\nHere are the assessor's contact details:\n- Phone: ${assessor.phone}\n- Email: ${assessor.email}\n\nPlease feel free to reach out to the assessor to coordinate the visit.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
      );
    }
  }

  return claim;
};


const awardBidToGarage = async (id, bidId, req) => {
  const claim = await Claim.findById(id)
  if (!claim) throw new Error('Claim not found');

  let selectedBidId = bidId;
  if (!selectedBidId) {
    const pendingGarageBids = claim.bids.filter(
      (garageBid) => garageBid.bidderType === 'garage' && garageBid.status === 'pending'
    );
    if (!pendingGarageBids.length) throw new Error('No pending garage bids');
    selectedBidId = selectBestGarageBid(pendingGarageBids)?._id;
  }

  const bid = claim.bids.id(selectedBidId);
  if (!bid || bid.status !== 'pending') throw new Error('Invalid bid');
  bid.status = 'awarded';

  claim.awardedGarage = {
    garageId: bid.garageId,
    awardedAmount: bid.totalCost,
    awardedDate: Date.now(),
  };
  claim.status = 'Repair';

  claim.bids.forEach((otherBid) => {
    if (otherBid._id.toString() !== selectedBidId.toString() && otherBid.bidderType === 'garage') {
      otherBid.status = 'rejected';
    }
  });

  const garage = await Garage.findById(bid.garageId);
  if (!garage) throw new Error('Garage not found');

  garage.pendingWork = (garage.pendingWork || 0) + 1;
  await garage.save();

  await notificationService.createAndEmit({
    recipientId: bid.garageId,
    recipientType: 'garage',
    type: 'bid_awarded',
    title: 'Bid Awarded',
    content: `Your bid for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been awarded.`,
    claimId: claim._id,
  });
  const start = Date.now();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Awarded garage bid for claim ${id} to garage (bid ${selectedBidId})`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Assessed' }, new: { status: 'Repair', awardedGarage: claim.awardedGarage } },
  });

  // Email to Garage
  if (garage.email) {
    await emailService.sendEmailNotification(
      garage.email,
      'Bid Award Notification',
      `Dear ${garage.name},\n\nCongratulations! Your bid for the claim with ID: ${claim.vehiclesInvolved[0].licensePlate} has been awarded. You are requested to proceed with the repair of the vehicle as soon as possible.\n\nPlease ensure that all necessary repairs are completed in a timely and professional manner.\n\nThank you for your cooperation.\n\nBest Regards,\nAdmin Team`
    );
  }

  // Email to Customer
  // Assuming claim has `customerId` populated
  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant?.email,
      'Repair Details for Your Vehicle',
      `Dear ${claim.claimant?.name},\n
      \nWe are pleased to inform you that your claim for (ID: ${claim.vehiclesInvolved[0].licensePlate}) has been processed, and your vehicle will be repaired at the following garage:\n
      \nGarage Details:
      \n- Name: ${garage.name}
      \n- Location: ${garage.location.name},
      \n- Timeline: ${bid.garageDetails.$exists ? bid.garageDetails.timeline : 'No timeline available'}
      \n- Ratings: ${garage.ratings.averageRating || 'No ratings available'}
      \n- Description: ${garage.description || 'No description available'}\n
      \nThe garage will contact you shortly to proceed with the repairs. If you have any questions, please feel free to reach out.\n\nThank you for choosing our services.\n\nBest Regards,\nAdmin Team`
    );
  }

  return claim;
};
// Award claim to a garage directly (without a specific bid)
const awardClaimToGarage = async (claimId, garageId) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  const garage = await Garage.findById(garageId);
  if (!garage) throw new Error('Garage not found');
  // Just create a new bid for the garage and award it
  const newBid = {
    bidderType: 'garage',
    garageId: garage._id,
    totalCost: 0, // Assuming no cost is provided
    status: 'awarded',
  };
  claim.bids.push(newBid);
  claim.awardedGarage = {
    garageId: garage._id,
    awardedAmount: 0,
    awardedDate: Date.now(),
  };
  claim.status = 'Repair';
  // Increment pending work for the garage
  garage.pendingWork = (garage.pendingWork || 0) + 1;
  await garage.save();
  await claim.save();
  return claim;
};





// Reject a specific assessor bid
const rejectAssessorBid = async (id, bidId, req) => {
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');

  const bid = claim.bids.id(bidId);
  if (!bid || bid.bidderType !== 'assessor') throw new Error('Assessor bid not found');
  if (bid.status !== 'pending') throw new Error('Only pending bids can be rejected');

  bid.status = 'rejected';

  await notificationService.createAndEmit({
    recipientId: bid.assessorId,
    recipientType: 'assessor',
    type: 'bid_rejected',
    title: 'Bid Rejected',
    content: `Your bid for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been rejected.`,
    claimId: claim._id,
  });

  const start = Date.now();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Rejected assessor bid ${bidId} on claim ${id}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { bidId, old: { status: 'pending' }, new: { status: 'rejected' } },
  });

  const assessor = await Assessor.findById(bid.assessorId);
  if (assessor && assessor.email) {
    await emailService.sendEmailNotification(
      assessor.email,
      'Bid Rejection Notification',
      `Dear ${assessor.name},\n\nWe regret to inform you that your bid for claim ID: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has not been successful.\n\nThank you for your participation.\n\nBest Regards,\nAdmin Team`
    );
  }

  return claim;
};

// Reject a specific garage bid
const rejectGarageBid = async (id, bidId, req) => {
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');

  const bid = claim.bids.id(bidId);
  if (!bid || bid.bidderType !== 'garage') throw new Error('Garage bid not found');
  if (bid.status !== 'pending') throw new Error('Only pending bids can be rejected');

  bid.status = 'rejected';

  await notificationService.createAndEmit({
    recipientId: bid.garageId,
    recipientType: 'garage',
    type: 'bid_rejected',
    title: 'Bid Rejected',
    content: `Your bid for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been rejected.`,
    claimId: claim._id,
  });

  const start = Date.now();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Rejected garage bid ${bidId} on claim ${id}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { bidId, old: { status: 'pending' }, new: { status: 'rejected' } },
  });

  const garage = await Garage.findById(bid.garageId);
  if (garage && garage.email) {
    await emailService.sendEmailNotification(
      garage.email,
      'Bid Rejection Notification',
      `Dear ${garage.name},\n\nWe regret to inform you that your bid for claim ID: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has not been successful.\n\nThank you for your participation.\n\nBest Regards,\nAdmin Team`
    );
  }

  return claim;
};

// Get awarded claims
const getAwardedClaims = async () => {
  return await Claim.find({ awardedAssessor: { $exists: true } });
};
const updateClaim = async (id, updateData) => {
  updateData.status = 'Repair';
  updateData.awardedGarage.awardedAmount = 0,
    updateData.awardedGarage.awardedDate = Date.now()
  updateData.awardedGarage.bidId = "selected-garage"

  const garage = await Garage.findById(updateData.awardedGarage.garageId);
  if (!garage) throw new Error('Garage not found');

  garage.pendingWork = (garage.pendingWork || 0) + 1;
  await garage.save();
  return await Claim.findByIdAndUpdate(id, updateData, { new: true });
};

// Get bids by claim
const getBidsByClaim = async (id) => {
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');
  return {
    bids: claim.bids.filter(bid => bid.bidderType === 'assessor'),
    selfRepair: {
      opted: claim.selfRepair?.opted ?? false,
      status: claim.selfRepair?.status ?? null,
    },
  };
};

// Get garage bids by claim
const getGarageBidsByClaim = async (id) => {
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');
  return claim.bids.filter(bid => bid.bidderType === 'garage');
};

// Garage finds assessed claims for repair
const garageFindsAssessedClaimsForRepair = async () => {
  return await Claim.find({ status: 'Assessed' });
};

// Get assessed claim by ID
const getAssessedClaimById = async (id) => {
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');
  return claim;
};

// Get assessed claims by garage
const getAssessedClaimsByGarage = async (garageId) => {
  return await Claim.find({ garage: garageId, status: 'Assessed' });
};

// Get all supplier bids for a claim
const getSupplierBidsForClaim = async (claimId) => {
  const claim = await Claim.findById(claimId).populate('supplierBids');
  if (!claim) throw new Error('Claim not found');
  return claim.supplierBids;
};

// Accept a supplier bid
const acceptSupplierBid = async (claimId, bidId, req) => {
  const supplyBid = await SupplyBid.findById(bidId);
  if (!supplyBid) throw new Error('Supply bid not found');

  const start = Date.now();
  supplyBid.status = 'Accepted';
  await supplyBid.save();

  await SupplyBid.updateMany(
    { _id: { $ne: bidId }, claimId: claimId },
    { $set: { status: 'Rejected' } }
  );

  const claim = await Claim.findById(claimId);
  claim.status = 'Garage';
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'SupplyBid',
    actionDescription: `Accepted supplier bid ${bidId} for claim ${claimId}`,
    resourceType: 'SupplyBid',
    resourceId: supplyBid._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending' }, new: { status: 'Accepted' } },
  });

  return supplyBid;
};

// Award a supplier bid (accept it and reject all others for the claim)
const awardSupplierBid = async (claimId, bidId, req) => {
  const supplyBid = await SupplyBid.findById(bidId);
  if (!supplyBid) throw new Error('Supply bid not found');
  if (supplyBid.status !== 'Pending') throw new Error('Only pending bids can be awarded');

  const start = Date.now();
  supplyBid.status = 'Accepted';
  await supplyBid.save();

  await SupplyBid.updateMany(
    { _id: { $ne: bidId }, claimId },
    { $set: { status: 'Rejected' } }
  );

  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  claim.status = 'Garage';
  await claim.save();

  await notificationService.createAndEmit({
    recipientId: supplyBid.supplierId,
    recipientType: 'supplier',
    type: 'bid_awarded',
    title: 'Bid Awarded',
    content: `Your parts bid for claim ${claimId} has been awarded.`,
    claimId,
  });

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'SupplyBid',
    actionDescription: `Awarded supplier bid ${bidId} for claim ${claimId}`,
    resourceType: 'SupplyBid',
    resourceId: supplyBid._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending' }, new: { status: 'Accepted' } },
  });

  const supplier = await Supplier.findById(supplyBid.supplierId);
  if (supplier && supplier.email) {
    await emailService.sendEmailNotification(
      supplier.email,
      'Bid Award Notification',
      `Dear ${supplier.name},\n\nCongratulations! Your parts bid for claim ID: ${claimId} has been awarded. Please proceed with delivering the parts as soon as possible.\n\nBest Regards,\nAdmin Team`
    );
  }

  return supplyBid;
};

// Reject a specific supplier bid
const rejectSupplierBid = async (claimId, bidId, req) => {
  const supplyBid = await SupplyBid.findById(bidId);
  if (!supplyBid) throw new Error('Supply bid not found');
  if (supplyBid.status !== 'Pending') throw new Error('Only pending bids can be rejected');

  const start = Date.now();
  supplyBid.status = 'Rejected';
  await supplyBid.save();

  await notificationService.createAndEmit({
    recipientId: supplyBid.supplierId,
    recipientType: 'supplier',
    type: 'bid_rejected',
    title: 'Bid Rejected',
    content: `Your parts bid for claim ${claimId} has been rejected.`,
    claimId,
  });

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'SupplyBid',
    actionDescription: `Rejected supplier bid ${bidId} for claim ${claimId}`,
    resourceType: 'SupplyBid',
    resourceId: supplyBid._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending' }, new: { status: 'Rejected' } },
  });

  const supplier = await Supplier.findById(supplyBid.supplierId);
  if (supplier && supplier.email) {
    await emailService.sendEmailNotification(
      supplier.email,
      'Bid Rejection Notification',
      `Dear ${supplier.name},\n\nWe regret to inform you that your parts bid for claim ID: ${claimId} has not been successful.\n\nThank you for your participation.\n\nBest Regards,\nAdmin Team`
    );
  }

  return supplyBid;
};

const countClaimsByStatus = async () => {
  const allStatuses = ['Pending', 'Approved', 'Rejected', 'Assessment', 'Assessed', 'Repair', 'Garage', 'Re-Assessment', 'Completed'];

  // Fetch counts from the database
  const counts = await Claim.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  // Create a map for quick lookup of counts by status
  const countsMap = new Map(counts.map(count => [count._id, count.count]));

  // Ensure all statuses are represented in the result
  const result = allStatuses.map(status => ({
    _id: status,
    count: countsMap.get(status) || 0
  }));
  return result.reduce((acc, curr) => {
    acc[curr._id] = curr.count;
    return acc;
  }, {});
};
const getPaymentTotals = async () => {
  const result = await Claim.aggregate([
    // Unwind the bids array to process each bid
    { $unwind: { path: '$bids', preserveNullAndEmptyArrays: true } },
    // Match only awarded garage bids
    {
      $match: {
        'bids.bidderType': 'garage',
        'bids.status': 'awarded',
      },
    },
    // Calculate the total cost of parts in awarded garage bids
    {
      $group: {
        _id: '$_id', // Group by claim ID
        totalGaragePayments: {
          $sum: { $sum: '$bids.parts.cost' }, // Sum the costs of parts in awarded garage bids
        },
        totalAssessorPayments: { $first: '$awardedAssessor.awardedAmount' },
        supplierBids: { $first: '$supplierBids' }, // Include supplierBids for lookup
      },
    },
    // Lookup supplier bids from the SupplierBids collection
    {
      $lookup: {
        from: 'supplybids',
        localField: 'supplierBids', // Field in the Claim collection
        foreignField: '_id', // Field in the SupplierBids collection
        as: 'supplierBidsDetails', // Name of the array field to store the matched supplier bids
      },
    },
    // Unwind the supplierBidsDetails array to process each supplier bid
    { $unwind: { path: '$supplierBidsDetails', preserveNullAndEmptyArrays: true } },
    // Match only supplier bids with status 'Accepted'
    {
      $match: {
        'supplierBidsDetails.status': 'Accepted',
      },
    },
    // Group by claim to calculate total supplier payments for each claim
    {
      $group: {
        _id: '$_id', // Group by claim ID
        totalGaragePayments: { $first: '$totalGaragePayments' },
        totalAssessorPayments: { $first: '$totalAssessorPayments' },
        totalSupplierPayments: { $sum: '$supplierBidsDetails.totalCost' }, // Sum the totalCost of accepted supplier bids
      },
    },
    // Group all claims to calculate overall totals
    {
      $group: {
        _id: null, // Group all claims together
        totalGaragePayments: { $sum: '$totalGaragePayments' },
        totalAssessorPayments: { $sum: '$totalAssessorPayments' },
        totalSupplierPayments: { $sum: '$totalSupplierPayments' },
        totalAssessedClaims: { $sum: 1 },
        totalPaid: { $sum: { $add: ['$totalGaragePayments', '$totalAssessorPayments', '$totalSupplierPayments'] } },
      },
    },
    // Project the final result
    {
      $project: {
        _id: 0, // Exclude the _id field
        totalGaragePayments: 1,
        totalAssessorPayments: 1,
        totalSupplierPayments: 1,
        totalAssessedClaims: 1,
        totalPaid: 1,
      },
    },
  ]);
  return result.length > 0 ? result[0] : {};
};



// Customer opts in to self-repair — only allowed when claim is Assessed
// Body: { selfRepair: { parts: [{ partName, cost }], other, description } }
const optInSelfRepair = async (claimId, estimate, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Assessed') throw new Error('Self-repair is only available for assessed claims');
  if (claim.selfRepair && claim.selfRepair.opted) throw new Error('Self-repair already opted in for this claim');

  const { parts = [], other = 0, description = '' } = estimate || {};

  const start = Date.now();
  claim.status = 'SelfRepair';
  claim.selfRepair = {
    opted: true,
    status: 'Submitted',
    estimate: { parts, other: Number(other) || 0, description },
  };
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Customer opted in to self-repair for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Assessed' }, new: { status: 'SelfRepair' } },
  });

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Opt-In Confirmation',
      `Dear ${claim.claimant.name},\n\nYou have opted to repair your vehicle yourself for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id}.\n\nPlease submit your repair receipts and the total amount spent so we can process your reimbursement.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }

  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_opted',
      title: 'Self-Repair Opt-In Confirmed',
      content: `You have opted in for self-repair on claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id}. Please submit your receipts.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Customer submits receipts, amount and banking details for reimbursement
const submitSelfRepair = async (claimId, { bankingDetails }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'SelfRepair') throw new Error('Claim is not in self-repair status');
  if (!claim.selfRepair || !claim.selfRepair.opted) throw new Error('Self-repair was not opted in for this claim');

  const { paymentMethod, phoneNumber, bankName, accountHolderName, accountNumber, amountRequested, description, receipts } = bankingDetails || {};

  if (!amountRequested || Number(amountRequested) <= 0) throw new Error('A valid amountRequested is required');
  if (!receipts || receipts.length === 0) throw new Error('At least one receipt is required');
  if (!paymentMethod) throw new Error('paymentMethod is required');

  const isMpesa = paymentMethod.toLowerCase().includes('mpesa');
  if (isMpesa && !phoneNumber) throw new Error('phoneNumber is required for Mpesa payments');
  if (!isMpesa && (!bankName || !accountNumber)) throw new Error('bankName and accountNumber are required for bank payments');

  const start = Date.now();
  claim.selfRepair.amountRequested = Number(amountRequested);
  claim.selfRepair.receipts = receipts;
  claim.selfRepair.description = description || '';
  claim.selfRepair.bankingDetails = { paymentMethod, phoneNumber, bankName, accountHolderName, accountNumber };
  claim.selfRepair.status = 'In-Review';
  claim.selfRepair.submittedAt = new Date();
  claim.status = 'Re-Assessment';
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Self-repair submission received for claim ${claimId}, sent for re-assessment`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'SelfRepair', selfRepairStatus: 'Submitted' }, new: { status: 'Re-Assessment' } },
  });

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Submission Received',
      `Dear ${claim.claimant.name},\n\nWe have received your self-repair submission for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id}.\n\nAmount requested: ${Number(amountRequested)}\n\nOur team will review your submission and notify you of the outcome shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }

  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_submitted',
      title: 'Self-Repair Submitted',
      content: `Your self-repair submission for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} is under review.`,
      claimId: claim._id,
    });
  }

  // Notify the assessor who originally assessed the claim
  const assessorId = claim.awardedAssessor?.assessorId;
  if (assessorId) {
    await notificationService.createAndEmit({
      recipientId: assessorId,
      recipientType: 'assessor',
      type: 'self_repair_submitted',
      title: 'Re-Assessment Required',
      content: `The customer has submitted a self-repair claim for ${claim.vehiclesInvolved[0]?.licensePlate || claim._id}. Please review and re-assess.`,
      claimId: claim._id,
    });

    const assessor = await Assessor.findById(assessorId);
    if (assessor && assessor.email) {
      await emailService.sendEmailNotification(
        assessor.email,
        'Re-Assessment Required',
        `Dear ${assessor.name},\n\nThe customer has completed a self-repair for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} and has submitted their repair costs for review.\n\nAmount requested: ${Number(amountRequested)}\n\nPlease log in to review the submission and provide your re-assessment.\n\nBest Regards,\nAdmin Team`
      );
    }
  }

  return claim;
};

// Admin approves the self-repair reimbursement
const approveSelfRepair = async (claimId, { amountApproved }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!claim.selfRepair || claim.selfRepair.status !== 'Submitted') throw new Error('No submitted self-repair to approve');
  if (!amountApproved || amountApproved <= 0) throw new Error('A valid approved amount is required');

  const start = Date.now();
  claim.selfRepair.amountApproved = amountApproved;
  claim.selfRepair.status = 'Approved';
  claim.selfRepair.approvedAt = new Date();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Approved self-repair reimbursement for claim ${claimId}, amount: ${amountApproved}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { selfRepairStatus: 'Submitted' }, new: { selfRepairStatus: 'Approved', amountApproved } },
  });

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Reimbursement Approved',
      `Dear ${claim.claimant.name},\n\nGreat news! Your self-repair reimbursement for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been approved.\n\nApproved reimbursement amount: R${amountApproved}\n\nPayment will be processed to your provided banking details shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }

  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_approved',
      title: 'Self-Repair Reimbursement Approved',
      content: `Your self-repair reimbursement of R${amountApproved} for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been approved.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Admin rejects the self-repair reimbursement
const rejectSelfRepair = async (claimId, { rejectionReason }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!claim.selfRepair || claim.selfRepair.status !== 'Submitted') throw new Error('No submitted self-repair to reject');
  if (!rejectionReason || !rejectionReason.trim()) throw new Error('Rejection reason is required');

  const start = Date.now();
  claim.selfRepair.status = 'Rejected';
  claim.selfRepair.rejectionReason = rejectionReason.trim();
  claim.status = 'Assessed';
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Rejected self-repair reimbursement for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { selfRepairStatus: 'Submitted' }, new: { selfRepairStatus: 'Rejected', rejectionReason } },
  });

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Reimbursement Not Approved',
      `Dear ${claim.claimant.name},\n\nWe regret to inform you that your self-repair reimbursement for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has not been approved.\n\nReason: ${rejectionReason.trim()}\n\nIf you believe this decision is incorrect, please contact our support team.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }

  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_rejected',
      title: 'Self-Repair Reimbursement Rejected',
      content: `Your self-repair reimbursement for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} was not approved. Reason: ${rejectionReason.trim()}`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Admin marks reimbursement as paid — closes the claim
const markSelfRepairPaid = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!claim.selfRepair || claim.selfRepair.status !== 'In-Review') throw new Error('Self-repair must be in review before marking as paid');

  const start = Date.now();
  claim.selfRepair.status = 'Paid';
  claim.selfRepair.paidAt = new Date();
  claim.status = 'Completed';
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Self-repair reimbursement marked as paid for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'SelfRepair', selfRepairStatus: 'Approved' }, new: { status: 'Completed', selfRepairStatus: 'Paid' } },
  });

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Reimbursement Paid',
      `Dear ${claim.claimant.name},\n\nYour self-repair reimbursement of R${claim.selfRepair.amountApproved} for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been paid to your provided banking details.\n\nYour claim is now closed.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }

  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_paid',
      title: 'Reimbursement Paid',
      content: `Your self-repair reimbursement of KES${claim.selfRepair.amountApproved} for claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been paid. Claim closed.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Assessor re-assesses a self-repaired vehicle
const reAssessSelfRepair = async (claimId, { notes, recommendedAmount }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Re-Assessment') throw new Error('Claim is not in Re-Assessment status');
  if (!claim.selfRepair || !claim.selfRepair.opted) throw new Error('This claim has no self-repair request');
  if (!notes || !notes.trim()) throw new Error('Re-assessment notes are required');
  if (!recommendedAmount || Number(recommendedAmount) <= 0) throw new Error('A valid recommendedAmount is required');

  const start = Date.now();
  claim.selfRepair.reAssessmentReport = {
    notes: notes.trim(),
    recommendedAmount: Number(recommendedAmount),
    assessedAt: new Date(),
  };
  claim.selfRepair.status = 'In-Review';
  claim.status = 'Completed';
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Assessor submitted re-assessment report for self-repair claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Re-Assessment', selfRepairStatus: 'Submitted' }, new: { status: 'Assessed', selfRepairStatus: 'In-Review' } },
  });

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Re-Assessment Complete',
      `Dear ${claim.claimant.name},\n\nYour self-repair submission for claim reference: ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been re-assessed.\n\nRecommended reimbursement amount: ${Number(recommendedAmount)}\n\nOur team will now review the assessor's report and finalise your reimbursement. You will be notified of the outcome shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }

  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_submitted',
      title: 'Re-Assessment Complete',
      content: `Your self-repair claim ${claim.vehiclesInvolved[0]?.licensePlate || claim._id} has been re-assessed. Recommended amount: ${Number(recommendedAmount)}.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Get all claims that are in self-repair workflow
const getSelfRepairClaims = async () => {
  return await Claim.find({ 'selfRepair.opted': true }).sort({ createdAt: -1 });
};

// Customer resubmits a rejected claim with updated details
const resubmitRejectedClaim = async (id, updateData, req) => {
  const claim = await Claim.findById(id);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Rejected') throw new Error('Only rejected claims can be resubmitted');

  const allowedFields = [
    'incidentDetails', 'vehiclesInvolved', 'drivers', 'passengers',
    'damage', 'description', 'damagedParts', 'injuries', 'witnesses',
    'policeReport', 'supportingDocuments', 'additionalInfo',
  ];

  allowedFields.forEach((field) => {
    if (updateData[field] !== undefined) {
      claim[field] = updateData[field];
    }
  });

  claim.status = 'Resubmitted';

  const start = Date.now();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Customer resubmitted rejected claim ${id}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Rejected' }, new: { status: 'Resubmitted' } },
  });

  return claim;
};

module.exports = {
  generateClaimLink,
  fileClaimService,
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
  updateClaim,
  countClaimsByStatus,
  getPaymentTotals,
  awardClaimToGarage,
  rejectAssessorBid,
  rejectGarageBid,
  awardSupplierBid,
  rejectSupplierBid,
  optInSelfRepair,
  submitSelfRepair,
  reAssessSelfRepair,
  approveSelfRepair,
  rejectSelfRepair,
  markSelfRepairPaid,
  getSelfRepairClaims,
  resubmitRejectedClaim,
};
