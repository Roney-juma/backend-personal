const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const { writeAuditLog } = require('../utils/auditHelper');
const SupplyBid = require('../models/supplyBids.model');
const Supplier = require('../models/supplier.model');
const notificationService = require('./notification.service');
const emailService = require('./email.service');
const whatsappService = require('./whatsapp.service');
const ClaimToken = require('../models/claimToken.model');
const crypto = require('crypto');
const logger = require('../middlewheres/logger');
const cache = require('../cache');

const invalidateClaimCache = async (claimId) => {
  const ops = [cache.delPattern('cache:claims:*')];
  if (claimId) ops.push(cache.del(`cache:claim:${claimId}`));
  await Promise.all(ops);
};

const MOTOR_GLASS_TYPE_ID = '6a43d317ea0c6f0a546da885';
const isGlassClaim = (claim) =>
  claim.claimTypeId && claim.claimTypeId.toString() === MOTOR_GLASS_TYPE_ID;

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


    const ttlHours = Number(process.env.CLAIM_LINK_TTL_HOURS || 72);
    const claimToken = new ClaimToken({
      customerId,
      token,
      expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
    });

    await claimToken.save();

    const claimLink = `https://avics.aveafrica.com/file-claim/${token}`;
    const claimLinkMessage = `Dear ${customer.firstName},\n\nClick this link to file a claim: ${claimLink}\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`;
    await emailService.sendEmailNotification(email, 'File a claim here', claimLinkMessage);
    if (customer.phone) {
      await whatsappService.sendWhatsAppMessage(
        customer.phone,
        `Hi ${customer.firstName}, your claim link is ready:\n${claimLink}\n\nThis link is for one-time use. — Ave Insurance`
      );
    }
    return claimLink;
  } catch (error) {
    logger.error('Failed to generate claim link: %s', error.message);
    return { error: 'Failed to generate claim link' };
  }
};


// Generate a link that opens the conversational AI claim-filing assistant.
// Uses the same single-use token mechanism, but points at /ai/claim-intake.
const generateAiClaimLink = async (email) => {
  try {
    const customer = await Customer.findOne({ email });

    if (!customer) {
      return { error: 'Customer not found' };
    }
    const token = crypto.randomBytes(20).toString('hex');

    const ttlHours = Number(process.env.CLAIM_LINK_TTL_HOURS || 72);
    const claimToken = new ClaimToken({
      customerId: customer._id,
      token,
      expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
    });

    await claimToken.save();

    // Base of the AI chat page (the API host that serves GET /ai/claim-intake).
    const base = (process.env.AI_INTAKE_URL || 'https://avics.aveafrica.com/ai/claim-intake').replace(/\/$/, '');
    const claimLink = `${base}/${token}`;

    await emailService.sendEmailNotification(
      email,
      'File your claim with our AI assistant',
      `Dear ${customer.firstName},\n\nClick this link to file your claim by chatting with our assistant: ${claimLink}\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
    return claimLink;
  } catch (error) {
    logger.error('Failed to generate AI claim link: %s', error.message);
    return { error: 'Failed to generate AI claim link' };
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
    if (claimToken.expiresAt && claimToken.expiresAt.getTime() < Date.now()) {
      throw new Error('This link has expired');
    }
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
        email: customer.email,
      },
      ...claimDetails,
    });
    const start = Date.now();
    await newClaim.save();
    await invalidateClaimCache(newClaim._id);

    // Consume the token only after the claim is safely persisted, so a failed
    // save doesn't burn the customer's only link.
    claimToken.used = true;
    await claimToken.save();

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
    const submissionMsg = `Dear ${newClaim.claimant.name},\n\nYour claim has been successfully submitted and is now being processed. Our team will review your claim and get back to you shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`;
    if (newClaim.claimant.email) {
      await emailService.sendEmailNotification(newClaim.claimant.email, 'Claim Submission Confirmation', submissionMsg);
    }
    if (newClaim.claimant.phone) {
      await whatsappService.sendWhatsAppMessage(
        newClaim.claimant.phone,
        `Hi ${newClaim.claimant.name}, your claim has been submitted and is under review. We'll keep you updated. — Ave Insurance`
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
    await invalidateClaimCache(claim._id);

    const createConfirmMsg = `Dear ${claimant.name},\n\nYour claim has been successfully submitted and is now being processed. Our team will review your claim and get back to you shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`;
    if (claimant.email) {
      await emailService.sendEmailNotification(claimant.email, 'Claim Submission Confirmation', createConfirmMsg);
    }
    if (claimant.phone) {
      await whatsappService.sendWhatsAppMessage(
        claimant.phone,
        `Hi ${claimant.name}, your claim has been submitted successfully and is under review. We'll update you at each step. — Ave Insurance`
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
  return cache.wrap(`cache:claims:customer:${customerId}`, () =>
    Claim.find({ customerId })
      .populate('customerId')
      .populate({ path: 'garageRepairReport.garageId', select: 'name email contactNumber _id' })
      .populate({ path: 'reAssessmentReport.assessorId', select: 'name email _id' }),
  600);
};

// Approve a claim — auto-detects glass claims and sets GlassApproved status
const approveClaim = async (id, req) => {
  const existing = await Claim.findById(id);
  if (!existing) throw new Error('Claim not found');

  const glass = isGlassClaim(existing);
  const newStatus = glass ? 'GlassApproved' : 'Approved';

  const start = Date.now();
  const claim = await Claim.findByIdAndUpdate(id, { status: newStatus }, { new: true });
  await invalidateClaimCache(id);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Approved ${glass ? 'glass ' : ''}claim ${id}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: existing.status }, new: { status: newStatus } },
  });

  const claimant = claim.claimant;
  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;

  if (glass) {
    if (claimant?.email) {
      await emailService.sendEmailNotification(
        claimant.email,
        'Glass Claim Approved',
        `Dear ${claimant.name},\n\nYour glass/windscreen claim (Reference: ${vehicle}) has been approved. A service provider will be assigned shortly to carry out the replacement.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
      );
    }
    if (claimant?.phone) {
      await whatsappService.sendWhatsAppMessage(
        claimant.phone,
        `Hi ${claimant.name}, your glass/windscreen claim (${vehicle}) has been *approved*. A service provider will be assigned shortly. — Ave Insurance`
      );
    }
    if (claim.customerId) {
      await notificationService.createAndEmit({
        recipientId: claim.customerId,
        recipientType: 'customer',
        type: 'claim_approved',
        title: 'Glass Claim Approved',
        content: `Your glass/windscreen claim (${vehicle}) has been approved. A service provider will be assigned shortly.`,
        claimId: claim._id,
      });
    }
  } else {
    if (claimant?.email) {
      await emailService.sendEmailNotification(
        claimant.email,
        'Claim Approval Notification',
        `Dear ${claimant.name},\n\nWe acknowledge receipt of your claim regarding vehicle registration number ${vehicle}.\n\nTo facilitate the claims process, an assessor will be appointed shortly to inspect and assess the vehicle. The assessment findings will enable us to determine the next steps and process your claim accordingly.\n\nOur team will keep you informed throughout the process and will contact you should any additional information be required.\n\nThank you for choosing Ave Insurance.\n\nKind regards,\n\nClaims Department\nAve Insurance`
      );
    }
    if (claimant?.phone) {
      await whatsappService.sendWhatsAppMessage(
        claimant.phone,
        `Hi ${claimant.name}, your claim (${vehicle}) has been *approved*. An assessor will be appointed shortly. — Ave Insurance`
      );
    }
    if (claim.customerId) {
      await notificationService.createAndEmit({
        recipientId: claim.customerId,
        recipientType: 'customer',
        type: 'claim_approved',
        title: 'Claim Approved',
        content: `Your claim (${vehicle}) has been approved.`,
        claimId: claim._id,
        whatsappNumber: claimant?.phone,
      });
    }
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
    await invalidateClaimCache(id);

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
  if (!claim) throw new Error('Claim not found');
  await invalidateClaimCache(id);

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
  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claimant && claimant.email) {
    await emailService.sendEmailNotification(
      claimant.email,
      'Claim Rejection Notification',
      `Dear ${claimant.name},\n\nWe regret to inform you that your claim (Reference: ${vehicle}) has been rejected.\n\nReason for rejection: ${rejectionReason.trim()}\n\nIf you believe this decision is incorrect or would like to discuss further, please contact our support team.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claimant && claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claimant.phone,
      `Hi ${claimant.name}, your claim (${vehicle}) has been *rejected*.\nReason: ${rejectionReason.trim()}\n\nContact support to discuss. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'claim_rejected',
      title: 'Claim Rejected',
      content: `Your claim (${vehicle}) has been rejected. Reason: ${rejectionReason.trim()}`,
      claimId: claim._id,
      whatsappNumber: claimant?.phone,
    });
  }

  return claim;
};

// Get a specific claim by ID
const getClaimById = async (id) => {
  return cache.wrap(`cache:claim:${id}`, async () => {
    const claim = await Claim.findById(id)
      .populate({ path: 'bids.assessorId', select: 'name email phone _id' })
      .populate({ path: 'bids.garageId', select: 'name email phone _id' })
      .populate({ path: 'garageRepairReport.garageId', select: 'name email contactNumber _id' })
      .populate({ path: 'reAssessmentReport.assessorId', select: 'name email _id' });
    if (!claim) throw new Error('Claim not found');
    return claim;
  }, 900);
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
  await invalidateClaimCache(id);

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
  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (assessor && assessor.email) {
    await emailService.sendEmailNotification(
      assessor.email,
      'Claim Award Notification',
      `Dear ${assessor.name},\n\nCongratulations! You have been awarded the claim with ID: ${vehicle}. You are required to submit a report within 3 days.\n\nPlease ensure that the report is submitted on time to facilitate the next steps in the claims process.\n\nBest Regards,\nAdmin Team`
    );
    if (assessor.contactInfo?.phone) {
      await whatsappService.sendWhatsAppMessage(
        assessor.contactInfo?.phone,
        `Hi ${assessor.name}, you have been *awarded* claim ${vehicle}. Please submit your assessment report within 3 days. — Ave Insurance`
      );
    }
  }
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Assessor Visit Notification',
      `Dear ${claim.claimant.name},\n\nWe are pleased to inform you that your claim with ID: ${vehicle} has been awarded to an assessor. The assessor, ${assessor?.name}, will be visiting to assess the state of your vehicle.\n\nHere are the assessor's contact details:\n- Phone: ${assessor?.phone}\n- Email: ${assessor?.email}\n\nPlease feel free to reach out to the assessor to coordinate the visit.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, an assessor has been assigned to your claim (${vehicle}).\n\nAssessor: ${assessor?.name}\nPhone: ${assessor?.phone}\nEmail: ${assessor?.email}\n\nThey will contact you to arrange a visit. — Ave Insurance`
    );
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
  await invalidateClaimCache(id);

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

  const gVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;

  if (garage.email) {
    await emailService.sendEmailNotification(
      garage.email,
      'Bid Award Notification',
      `Dear ${garage.name},\n\nCongratulations! Your bid for the claim with ID: ${gVehicle} has been awarded. You are requested to proceed with the repair of the vehicle as soon as possible.\n\nPlease ensure that all necessary repairs are completed in a timely and professional manner.\n\nThank you for your cooperation.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (garage.contactNumber) {
    await whatsappService.sendWhatsAppMessage(
      garage.contactNumber,
      `Hi ${garage.name}, your bid for claim ${gVehicle} has been *awarded*. Please proceed with the repair as soon as possible. — Ave Insurance`
    );
  }

  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Repair Details for Your Vehicle',
      `Dear ${claim.claimant.name},\n\nWe are pleased to inform you that your claim for (ID: ${gVehicle}) has been processed, and your vehicle will be repaired at the following garage:\n\nGarage Details:\n- Name: ${garage.name}\n- Location: ${garage.location.name}\n- Timeline: ${bid.garageDetails?.timeline || 'No timeline available'}\n- Ratings: ${garage.ratings.averageRating || 'No ratings available'}\n- Description: ${garage.description || 'No description available'}\n\nThe garage will contact you shortly to proceed with the repairs. If you have any questions, please feel free to reach out.\n\nThank you for choosing our services.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant?.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your vehicle (${gVehicle}) has been assigned to *${garage.name}* for repair.\n📍 ${garage.location.name}\n⭐ Rating: ${garage.ratings.averageRating || 'N/A'}\n\nThe garage will contact you shortly. — Ave Insurance`
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
  await invalidateClaimCache(claimId);
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
  await invalidateClaimCache(id);

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
  const raVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (assessor && assessor.email) {
    await emailService.sendEmailNotification(
      assessor.email,
      'Bid Rejection Notification',
      `Dear ${assessor.name},\n\nWe regret to inform you that your bid for claim ID: ${raVehicle} has not been successful.\n\nThank you for your participation.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (assessor && assessor.contactInfo?.phone) {
    await whatsappService.sendWhatsAppMessage(
      assessor.contactInfo?.phone,
      `Hi ${assessor.name}, your bid for claim ${raVehicle} was not successful this time. Thank you for participating. — Ave Insurance`
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
  await invalidateClaimCache(id);

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
  const rgVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (garage && garage.email) {
    await emailService.sendEmailNotification(
      garage.email,
      'Bid Rejection Notification',
      `Dear ${garage.name},\n\nWe regret to inform you that your bid for claim ID: ${rgVehicle} has not been successful.\n\nThank you for your participation.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (garage && garage.contactNumber) {
    await whatsappService.sendWhatsAppMessage(
      garage.contactNumber,
      `Hi ${garage.name}, your bid for claim ${rgVehicle} was not successful this time. Thank you for participating. — Ave Insurance`
    );
  }

  return claim;
};

// Get awarded claims
const getAwardedClaims = async () => {
  return cache.wrap('cache:claims:awarded', () => Claim.find({ awardedAssessor: { $exists: true } }), 300);
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
  const updatedClaim = await Claim.findByIdAndUpdate(id, updateData, { new: true });
  await invalidateClaimCache(id);
  return updatedClaim;
};

// Get bids by claim
const getBidsByClaim = async (id) => {
  return cache.wrap(`cache:claims:bids:${id}`, async () => {
    const claim = await Claim.findById(id);
    if (!claim) throw new Error('Claim not found');
    return {
      bids: claim.bids.filter(bid => bid.bidderType === 'assessor'),
      selfRepair: { opted: claim.selfRepair?.opted ?? false, status: claim.selfRepair?.status ?? null },
    };
  }, 300);
};

// Get garage bids by claim
const getGarageBidsByClaim = async (id) => {
  return cache.wrap(`cache:claims:garage-bids:${id}`, async () => {
    const claim = await Claim.findById(id);
    if (!claim) throw new Error('Claim not found');
    return claim.bids.filter(bid => bid.bidderType === 'garage');
  }, 300);
};

// Garage finds assessed claims for repair
const garageFindsAssessedClaimsForRepair = async () => {
  return cache.wrap('cache:claims:assessed', () => Claim.find({ status: 'Assessed' }), 300);
};

// Get assessed claim by ID
const getAssessedClaimById = async (id) => {
  return cache.wrap(`cache:claims:assessed:${id}`, async () => {
    const claim = await Claim.findById(id);
    if (!claim) throw new Error('Claim not found');
    return claim;
  }, 900);
};

// Get assessed claims by garage
const getAssessedClaimsByGarage = async (garageId) => {
  return cache.wrap(`cache:claims:assessed:garage:${garageId}`, () =>
    Claim.find({ garage: garageId, status: 'Assessed' }), 600);
};

// Get all supplier bids for a claim
const getSupplierBidsForClaim = async (claimId) => {
  return cache.wrap(`cache:claims:supplier-bids:${claimId}`, async () => {
    const claim = await Claim.findById(claimId).populate('supplierBids');
    if (!claim) throw new Error('Claim not found');
    return claim.supplierBids;
  }, 300);
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
  await invalidateClaimCache(claimId);

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

  const glass = isGlassClaim(claim);
  if (glass) {
    claim.status = 'GlassRepair';
    claim.glassRepair = {
      supplierId: supplyBid.supplierId,
      status: 'Assigned',
    };
  } else {
    claim.status = 'Garage';
  }
  await claim.save();
  await invalidateClaimCache(claimId);

  await notificationService.createAndEmit({
    recipientId: supplyBid.supplierId,
    recipientType: 'supplier',
    type: 'bid_awarded',
    title: 'Bid Awarded',
    content: `Your ${glass ? 'glass replacement' : 'parts'} bid for claim ${claimId} has been awarded.`,
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
    const emailBody = glass
      ? `Dear ${supplier.name},\n\nCongratulations! Your glass replacement bid for claim ID: ${claimId} has been awarded. Please contact the customer to arrange the replacement.\n\nCustomer: ${claim.claimant?.name}\nPhone: ${claim.claimant?.phone}\nEmail: ${claim.claimant?.email}\n\nBest Regards,\nAdmin Team`
      : `Dear ${supplier.name},\n\nCongratulations! Your parts bid for claim ID: ${claimId} has been awarded. Please proceed with delivering the parts as soon as possible.\n\nBest Regards,\nAdmin Team`;
    await emailService.sendEmailNotification(supplier.email, 'Bid Award Notification', emailBody);
  }
  if (supplier && supplier.phone) {
    const waMsg = glass
      ? `Hi ${supplier.name}, your glass replacement bid for claim ${claimId} has been *awarded*. Please contact the customer (${claim.claimant?.name} | ${claim.claimant?.phone}) to arrange. — Ave Insurance`
      : `Hi ${supplier.name}, your parts bid for claim ${claimId} has been *awarded*. Please proceed with delivering the parts. — Ave Insurance`;
    await whatsappService.sendWhatsAppMessage(supplier.phone, waMsg);
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
  if (supplier && supplier.phone) {
    await whatsappService.sendWhatsAppMessage(
      supplier.phone,
      `Hi ${supplier.name}, your parts bid for claim ${claimId} was not successful this time. Thank you for participating. — Ave Insurance`
    );
  }

  return supplyBid;
};

const countClaimsByStatus = async () => {
  return cache.wrap('cache:stats:claims:status', async () => {
    const allStatuses = ['Pending', 'Approved', 'Rejected', 'Assessment', 'Assessed', 'Repair', 'Garage', 'Re-Assessment', 'Completed'];
    const counts = await Claim.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const countsMap = new Map(counts.map(count => [count._id, count.count]));
    const result = allStatuses.map(status => ({ _id: status, count: countsMap.get(status) || 0 }));
    return result.reduce((acc, curr) => { acc[curr._id] = curr.count; return acc; }, {});
  }, 600);
};
const getPaymentTotals = async () => {
  return cache.wrap('cache:stats:claims:cost', async () => {
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
  }, 600);
};



// Customer opts in to self-repair — only allowed when claim is Assessed
// Body: { selfRepair: { parts: [{ partName, cost }], other, description } }
const optInSelfRepair = async (claimId, estimate, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Assessed' && claim.status !== 'GlassApproved') throw new Error('Self-repair / cash in lieu is only available for assessed or approved glass claims');
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
  await invalidateClaimCache(claimId);

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

  const srVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Opt-In Confirmation',
      `Dear ${claim.claimant.name},\n\nYou have opted to repair your vehicle yourself for claim reference: ${srVehicle}.\n\nPlease submit your repair receipts and the total amount spent so we can process your reimbursement.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, you've opted for *self-repair* on claim ${srVehicle}. Please submit your receipts and total cost to receive reimbursement. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_opted',
      title: 'Self-Repair Opt-In Confirmed',
      content: `You have opted in for self-repair on claim ${srVehicle}. Please submit your receipts.`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
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
  await invalidateClaimCache(claimId);

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

  const ssrVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Submission Received',
      `Dear ${claim.claimant.name},\n\nWe have received your self-repair submission for claim reference: ${ssrVehicle}.\n\nAmount requested: ${Number(amountRequested)}\n\nOur team will review your submission and notify you of the outcome shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, we've received your self-repair submission for claim ${ssrVehicle}.\nAmount requested: R${Number(amountRequested)}\n\nWe'll review and update you shortly. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_submitted',
      title: 'Self-Repair Submitted',
      content: `Your self-repair submission for claim ${ssrVehicle} is under review.`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
    });
  }

  // Notify the assessor who originally assessed the claim
  const assessorId = claim.awardedAssessor?.assessorId;
  if (assessorId) {
    const assessor = await Assessor.findById(assessorId);
    await notificationService.createAndEmit({
      recipientId: assessorId,
      recipientType: 'assessor',
      type: 'self_repair_submitted',
      title: 'Re-Assessment Required',
      content: `The customer has submitted a self-repair claim for ${ssrVehicle}. Please review and re-assess.`,
      claimId: claim._id,
      whatsappNumber: assessor?.contactInfo?.phone,
    });

    if (assessor && assessor.email) {
      await emailService.sendEmailNotification(
        assessor.email,
        'Re-Assessment Required',
        `Dear ${assessor.name},\n\nThe customer has completed a self-repair for claim reference: ${ssrVehicle} and has submitted their repair costs for review.\n\nAmount requested: ${Number(amountRequested)}\n\nPlease log in to review the submission and provide your re-assessment.\n\nBest Regards,\nAdmin Team`
      );
    }
    if (assessor && assessor.contactInfo?.phone) {
      await whatsappService.sendWhatsAppMessage(
        assessor.contactInfo?.phone,
        `Hi ${assessor.name}, re-assessment required for claim ${ssrVehicle}. The customer has submitted self-repair costs of R${Number(amountRequested)}. Please log in to review. — Ave Insurance`
      );
    }
  }

  return claim;
};

// Admin approves the self-repair reimbursement
const approveSelfRepair = async (claimId, { totalAwardedAmount, depositPercentage }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!claim.selfRepair || claim.selfRepair.status !== 'Submitted') throw new Error('No submitted self-repair to approve');
  if (!totalAwardedAmount || Number(totalAwardedAmount) <= 0) throw new Error('A valid totalAwardedAmount is required');
  if (!depositPercentage || Number(depositPercentage) <= 0 || Number(depositPercentage) >= 100) throw new Error('depositPercentage must be between 1 and 99');

  const total = Number(totalAwardedAmount);
  const pct = Number(depositPercentage);
  const deposit = Number((total * pct / 100).toFixed(2));
  const finalSettlement = Number((total - deposit).toFixed(2));

  const start = Date.now();
  claim.selfRepair.totalAwardedAmount = total;
  claim.selfRepair.depositPercentage = pct;
  claim.selfRepair.depositAmount = deposit;
  claim.selfRepair.finalSettlementAmount = finalSettlement;
  claim.selfRepair.amountApproved = total;
  claim.selfRepair.status = 'Approved';
  claim.selfRepair.approvedAt = new Date();
  await claim.save();
  await invalidateClaimCache(claimId);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Approved cash-in-lieu for claim ${claimId} — total: ${total}, deposit: ${pct}% (KES ${deposit}), final settlement: KES ${finalSettlement}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { selfRepairStatus: 'Submitted' }, new: { selfRepairStatus: 'Approved', totalAwardedAmount: total, depositPercentage: pct, depositAmount: deposit, finalSettlementAmount: finalSettlement } },
  });

  const aprVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Cash-in-Lieu Approved',
      `Dear ${claim.claimant.name},

Your cash-in-lieu request for claim reference: ${aprVehicle} has been approved.

Total awarded amount: KES ${total}
Initial deposit (paid first): KES ${deposit}
Final settlement (paid after re-assessment): KES ${finalSettlement}

Your initial deposit will be processed to your provided banking details shortly. Once you complete the repair, an assessor will verify the work and your final settlement will be released.

Thank you for choosing Ave Insurance.

Best Regards,
Admin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your cash-in-lieu for claim ${aprVehicle} has been *approved*.\n\nTotal: KES ${total}\nInitial deposit: KES ${deposit}\nFinal settlement: KES ${finalSettlement}\n\nYour deposit will be paid to your banking details shortly. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_approved',
      title: 'Cash-in-Lieu Approved',
      content: `Your cash-in-lieu of KES ${total} (deposit: KES ${deposit}) for claim ${aprVehicle} has been approved.`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
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
  await invalidateClaimCache(claimId);

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

  const rjVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Reimbursement Not Approved',
      `Dear ${claim.claimant.name},\n\nWe regret to inform you that your self-repair reimbursement for claim reference: ${rjVehicle} has not been approved.\n\nReason: ${rejectionReason.trim()}\n\nIf you believe this decision is incorrect, please contact our support team.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your self-repair reimbursement for claim ${rjVehicle} was not approved.\nReason: ${rejectionReason.trim()}\n\nPlease contact support to discuss. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_rejected',
      title: 'Self-Repair Reimbursement Rejected',
      content: `Your self-repair reimbursement for claim ${rjVehicle} was not approved. Reason: ${rejectionReason.trim()}`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
    });
  }

  return claim;
};

// Admin pays the initial deposit — client can now proceed with repairs
const payInitialDeposit = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!claim.selfRepair || claim.selfRepair.status !== 'Approved') throw new Error('Self-repair must be approved before paying the initial deposit');

  const start = Date.now();
  claim.selfRepair.status = 'DepositPaid';
  claim.selfRepair.depositPaidAt = new Date();
  await claim.save();
  await invalidateClaimCache(claimId);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Initial deposit of KES ${claim.selfRepair.depositAmount} paid for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { selfRepairStatus: 'Approved' }, new: { selfRepairStatus: 'DepositPaid', depositPaidAt: claim.selfRepair.depositPaidAt } },
  });

  const depVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Cash-in-Lieu Initial Deposit Paid',
      `Dear ${claim.claimant.name},

Your initial deposit of KES ${claim.selfRepair.depositAmount} for claim reference: ${depVehicle} has been paid to your provided banking details.

Please proceed with the repair. Once complete, an assessor will verify the work and your final settlement of KES ${claim.selfRepair.finalSettlementAmount} will be released.

Thank you for choosing Ave Insurance.

Best Regards,
Admin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your initial deposit of KES ${claim.selfRepair.depositAmount} for claim ${depVehicle} has been *paid*.\n\nPlease proceed with the repair. Your final settlement of KES ${claim.selfRepair.finalSettlementAmount} will follow after re-assessment. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_deposit_paid',
      title: 'Initial Deposit Paid',
      content: `Your initial deposit of KES ${claim.selfRepair.depositAmount} for claim ${depVehicle} has been paid. Proceed with repairs.`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
    });
  }

  return claim;
};

// Admin pays the final settlement after re-assessment — closes the claim
const payFinalSettlement = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!claim.selfRepair || claim.selfRepair.status !== 'In-Review') throw new Error('Re-assessment must be complete before paying the final settlement');
  if (!claim.selfRepair.depositPaidAt) throw new Error('Initial deposit must be paid before the final settlement');

  const start = Date.now();
  claim.selfRepair.status = 'SettlementPaid';
  claim.selfRepair.finalSettlementPaidAt = new Date();
  claim.selfRepair.paidAt = new Date();
  claim.status = 'Completed';
  await claim.save();
  await invalidateClaimCache(claimId);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Final settlement of KES ${claim.selfRepair.finalSettlementAmount} paid for claim ${claimId} — claim closed`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { selfRepairStatus: 'In-Review' }, new: { status: 'Completed', selfRepairStatus: 'SettlementPaid' } },
  });

  const setVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Cash-in-Lieu Final Settlement Paid — Claim Closed',
      `Dear ${claim.claimant.name},

Your final settlement of KES ${claim.selfRepair.finalSettlementAmount} for claim reference: ${setVehicle} has been paid to your provided banking details.

Summary:
- Initial deposit paid: KES ${claim.selfRepair.depositAmount}
- Final settlement paid: KES ${claim.selfRepair.finalSettlementAmount}
- Total cash-in-lieu received: KES ${claim.selfRepair.totalAwardedAmount}

Your claim is now closed. Thank you for choosing Ave Insurance.

Best Regards,
Admin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your final settlement of KES ${claim.selfRepair.finalSettlementAmount} for claim ${setVehicle} has been *paid*.\n\nTotal received: KES ${claim.selfRepair.totalAwardedAmount}. Your claim is now closed. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_settlement_paid',
      title: 'Final Settlement Paid — Claim Closed',
      content: `Final settlement of KES ${claim.selfRepair.finalSettlementAmount} paid for claim ${setVehicle}. Total received: KES ${claim.selfRepair.totalAwardedAmount}.`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
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
  // claim.status left as-is — final settlement payment closes the claim
  await claim.save();
  await invalidateClaimCache(claimId);

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

  const raVeh = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Self-Repair Re-Assessment Complete',
      `Dear ${claim.claimant.name},\n\nYour self-repair submission for claim reference: ${raVeh} has been re-assessed.\n\nRecommended reimbursement amount: R${Number(recommendedAmount)}\n\nOur team will now review the assessor's report and finalise your reimbursement. You will be notified of the outcome shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your self-repair claim ${raVeh} has been re-assessed.\nRecommended reimbursement: R${Number(recommendedAmount)}\n\nWe'll finalise and notify you of the outcome. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'self_repair_submitted',
      title: 'Re-Assessment Complete',
      content: `Your self-repair claim ${raVeh} has been re-assessed. Recommended amount: R${Number(recommendedAmount)}.`,
      claimId: claim._id,
      whatsappNumber: claim.claimant?.phone,
    });
  }

  return claim;
};

// Get all claims that are in self-repair workflow
const getSelfRepairClaims = async () => {
  return cache.wrap('cache:claims:self-repair', () =>
    Claim.find({ 'selfRepair.opted': true }).sort({ createdAt: -1 }), 600);
};

// Approve a glass claim — sets status to GlassApproved
const approveGlassClaim = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!isGlassClaim(claim)) throw new Error('This claim is not a motor glass claim');
  if (claim.status !== 'Pending' && claim.status !== 'Resubmitted') throw new Error('Only pending or resubmitted glass claims can be approved');

  const start = Date.now();
  claim.status = 'GlassApproved';
  await claim.save();
  await invalidateClaimCache(claimId);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Approved glass claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending' }, new: { status: 'GlassApproved' } },
  });

  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Glass Claim Approved',
      `Dear ${claim.claimant.name},\n\nYour glass/windscreen claim (Reference: ${vehicle}) has been approved. A service provider will be assigned shortly to carry out the replacement.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant?.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your glass/windscreen claim (${vehicle}) has been *approved*. A service provider will be assigned shortly. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'claim_approved',
      title: 'Glass Claim Approved',
      content: `Your glass/windscreen claim (${vehicle}) has been approved.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Admin assigns a supplier (service provider) to a glass claim
const assignGlassSupplier = async (claimId, { supplierId, appointmentDate, notes }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!isGlassClaim(claim)) throw new Error('This claim is not a motor glass claim');
  if (claim.status !== 'GlassApproved') throw new Error('Claim must be in GlassApproved status before assigning a supplier');

  const supplier = await Supplier.findById(supplierId);
  if (!supplier) throw new Error('Supplier not found');

  const start = Date.now();
  claim.glassRepair = {
    supplierId: supplier._id,
    appointmentDate: appointmentDate ? new Date(appointmentDate) : undefined,
    notes: notes || '',
    status: 'Assigned',
  };
  claim.status = 'GlassRepair';
  await claim.save();
  await invalidateClaimCache(claimId);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Assigned supplier ${supplierId} to glass claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'GlassApproved' }, new: { status: 'GlassRepair', supplierId } },
  });

  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (supplier.email) {
    await emailService.sendEmailNotification(
      supplier.email,
      'Glass Replacement Assignment',
      `Dear ${supplier.name},\n\nYou have been assigned to replace the windscreen/glass for claim ID: ${vehicle}.\n\n${appointmentDate ? `Appointment date: ${new Date(appointmentDate).toDateString()}\n\n` : ''}${notes ? `Notes: ${notes}\n\n` : ''}Please contact the customer to confirm the appointment.\n\nCustomer: ${claim.claimant?.name}\nPhone: ${claim.claimant?.phone}\nEmail: ${claim.claimant?.email}\n\nBest Regards,\nAdmin Team`
    );
  }
  if (supplier.phone) {
    await whatsappService.sendWhatsAppMessage(
      supplier.phone,
      `Hi ${supplier.name}, you have been assigned to a glass replacement for claim ${vehicle}.\nCustomer: ${claim.claimant?.name} | ${claim.claimant?.phone}${appointmentDate ? `\nAppointment: ${new Date(appointmentDate).toDateString()}` : ''}\n\nPlease contact the customer to confirm. — Ave Insurance`
    );
  }
  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Service Provider Assigned for Glass Replacement',
      `Dear ${claim.claimant.name},\n\nA service provider has been assigned to replace your windscreen/glass for claim (Reference: ${vehicle}).\n\nService Provider: ${supplier.name}\nPhone: ${supplier.phone}\nEmail: ${supplier.email}\n\nThey will contact you shortly to arrange the replacement.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant?.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, a service provider has been assigned for your glass replacement (${vehicle}).\n\n🔧 ${supplier.name}\n📞 ${supplier.phone}\n\nThey will contact you to arrange the replacement. — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'glass_supplier_assigned',
      title: 'Service Provider Assigned',
      content: `${supplier.name} has been assigned to replace your glass/windscreen for claim ${vehicle}.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Supplier marks the glass replacement as complete — closes the claim
const completeGlassRepair = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (!isGlassClaim(claim)) throw new Error('This claim is not a motor glass claim');
  if (claim.status !== 'GlassRepair') throw new Error('Claim must be in GlassRepair status to be completed');

  const start = Date.now();
  claim.glassRepair.status = 'Completed';
  claim.glassRepair.completedAt = new Date();
  claim.status = 'Completed';
  await claim.save();
  await invalidateClaimCache(claimId);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Glass repair completed for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'GlassRepair' }, new: { status: 'Completed' } },
  });

  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Glass Replacement Completed',
      `Dear ${claim.claimant.name},\n\nYour windscreen/glass replacement for claim (Reference: ${vehicle}) has been completed. Your claim is now closed.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  if (claim.claimant?.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, your glass/windscreen replacement for claim ${vehicle} has been *completed*. Your claim is now closed. ✅ — Ave Insurance`
    );
  }
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'claim_completed',
      title: 'Glass Replacement Completed',
      content: `Your glass/windscreen replacement for claim ${vehicle} is complete. Claim closed.`,
      claimId: claim._id,
    });
  }

  return claim;
};

// Get all glass/motor glass claims
const getGlassClaims = async () => {
  return cache.wrap('cache:claims:glass', () =>
    Claim.find({ claimTypeId: MOTOR_GLASS_TYPE_ID }).sort({ createdAt: -1 }), 600);
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
  await invalidateClaimCache(id);

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
  generateAiClaimLink,
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
  payInitialDeposit,
  payFinalSettlement,
  getSelfRepairClaims,
  resubmitRejectedClaim,
  approveGlassClaim,
  assignGlassSupplier,
  completeGlassRepair,
  getGlassClaims,
};
