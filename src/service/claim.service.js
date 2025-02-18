const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const SupplyBid = require('../models/supplyBids.model');
const Notification = require('../models/notification.model');
const emailService = require('./email.service');
const ClaimToken = require('../models/claimToken.model');
const crypto = require('crypto');

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

    const claimLink = `http://admin.aveafricasolutions.com/file-claim/${token}`;
    await emailService.sendEmailNotification(
      email,
      'File a claim here',
      `Dear ${customer.firstName},\n\nClick this link to file a claim: ${claimLink}\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
    return claimLink;
  } catch (error) {
    console.error(error);
    return { error: 'Failed to generate claim link' };
  }
};


// File the claim for Web

const fileClaimService = async (token, claimDetails) => {
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
    await newClaim.save();
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
const createClaim = async (data) => {
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
    const claim = new Claim(data);
    await claim.save();
    if (claimant.email) {
      await emailService.sendEmailNotification(
        claimant.email,
        'Claim Submission Confirmation',
        `Dear ${claimant.name},\n\nYour claim has been successfully submitted and is now being processed. Our team will review your claim and get back to you shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
      );
    }
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
        await awardClaim(claim._id, topRatedBid._id);
      }
    }

    // Check if the claim status is 'Garage' and has at least 3 garage bids
    if (claim.status === 'Garage' && claim.bids.length >= 3) {
      const garageBids = claim.bids.filter(bid => bid.bidderType === 'garage');
      if (garageBids.length === 0) continue;

      // Check if all garage bids are pending and none have been awarded
      const hasAwardedGarageBid = garageBids.some(bid => bid.status === 'awarded');
      const allGaragePending = garageBids.every(bid => bid.status === 'pending');

      if (hasAwardedGarageBid || !allGaragePending) {
        continue; // Skip this claim if any garage bid is already awarded or not all are pending
      }

      let topRatedGarageBid = null;
      let highestGarageRating = -1;

      // Find the top-rated garage bid
      for (let bid of garageBids) {
        if (bid.garageDetails && bid.garageDetails.ratings.averageRating > highestGarageRating) {
          highestGarageRating = bid.garageDetails.ratings.averageRating;
          topRatedGarageBid = bid;
        }
      }

      // Award the top-rated garage bid if found
      if (topRatedGarageBid) {
        await awardBidToGarage(claim._id, topRatedGarageBid._id);
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
const approveClaim = async (id) => {
  const claim = await Claim.findByIdAndUpdate(id, { status: 'Approved' }, { new: true });
  if (!claim) {
    throw new Error('Claim not found');
  }
  const claimant = claim.claimant;
  if (claimant && claimant.email) {
    await emailService.sendEmailNotification(
      claimant.email,
      'Claim Approval Notification',
      `Dear ${claimant.name},\n\nWe are pleased to inform you that your claim with ID: ${claim.vehiclesInvolved[0].licensePlate} has been approved. The compensation will be processed shortly.\n\nThank you for choosing Ave Insurance.\n\nBest Regards,\nAdmin Team`
    );
  }
  return claim;
};

// Delete a claim
const deleteClaim = async (id) => {
  return await Claim.findByIdAndDelete(id);
};

// Reject a claim
const rejectClaim = async (id) => {
  const claim = await Claim.findByIdAndUpdate(id, { status: 'rejected' }, { new: true });
  if (!claim) {
    throw new Error('Claim not found');
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
const awardClaim = async (id, bidId) => {
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

  // Send notification to the awarded assessor
  await Notification.create({
    recipientId: bid.assessorId,
    recipientType: 'assessor',
    content: `Your bid for claim ID: ${claim._id} has been awarded.`,
  });

  // Save the updated claim
  await claim.save();

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


const awardBidToGarage = async (id, bidId) => {
  const claim = await Claim.findById(id)
  if (!claim) throw new Error('Claim not found');

  const bid = claim.bids.id(bidId);
  if (!bid || bid.status !== 'pending') throw new Error('Invalid bid');
  bid.status = 'awarded';

  claim.awardedGarage = {
    garageId: bid.garageId,
    awardedAmount: bid.totalCost,
    awardedDate: Date.now(),
  };
  claim.status = 'Repair';

  claim.bids.forEach((otherBid) => {
    if (otherBid._id.toString() !== bidId && otherBid.bidderType === 'garage') {
      otherBid.status = 'rejected';
    }
  });

  const garage = await Garage.findById(bid.garageId);
  if (!garage) throw new Error('Garage not found');

  garage.pendingWork = (garage.pendingWork || 0) + 1;
  await garage.save();

  await Notification.create({
    recipientId: bid.garageId,
    recipientType: 'garage',
    content: `Your bid for claim ID: ${claim.vehiclesInvolved[0].licensePlate} has been awarded.`,
  });

  await claim.save();

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
  return claim.bids.filter(bid => bid.bidderType === 'assessor');
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
const acceptSupplierBid = async (claimId, bidId) => {
  const supplyBid = await SupplyBid.findById(bidId);
  if (!supplyBid) throw new Error('Supply bid not found');

  supplyBid.status = 'Accepted';
  await supplyBid.save();

  await SupplyBid.updateMany(
    { _id: { $ne: bidId }, claimId: claimId },
    { $set: { status: 'Rejected' } }
  );

  const claim = await Claim.findById(claimId);
  claim.status = 'Garage';
  await claim.save();

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

};
