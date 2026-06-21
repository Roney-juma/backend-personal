const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const bcrypt = require('bcrypt');
const Claim = require('../models/claim.model');
const ApiError = require('../utils/ApiError');
const emailService = require("../service/email.service");
const { writeAuditLog } = require('../utils/auditHelper');



const createAssessor = async (assessorData, req) => {
  const existingUser = await Assessor.findOne({ email: assessorData.email });
  if (existingUser) throw new ApiError(409, 'Assessor already exists');

  const start = Date.now();
  const safeData = { ...assessorData };
  delete safeData.password;

  safeData.password = await bcrypt.hash(assessorData.password, 10);
  assessorData.password = safeData.password;
  const newAssessor = await Assessor.create(assessorData);

  await writeAuditLog(req, {
    action: 'CREATE',
    module: 'Assessor',
    actionDescription: `Created assessor account for ${assessorData.email}`,
    resourceType: 'Assessor',
    resourceId: newAssessor._id,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: safeData },
  });

  return newAssessor;
};
const getAssessors = async () => {
  return await Assessor.find();
};

const getAssessorById = async (id) => {
  const assessor = await Assessor.findById(id);
  if (!assessor) throw new ApiError(404, 'Assessor not found');
  return assessor;
};

const updateAssessor = async (id, assessorData, req) => {
  const assessor = await Assessor.findById(id);
  if (!assessor) throw new ApiError(404, 'Assessor not found');

  const start = Date.now();
  const oldData = assessor.toObject();
  const updatedAssessor = await Assessor.findByIdAndUpdate(id, assessorData, { new: true });

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Assessor',
    actionDescription: `Updated assessor profile (ID: ${id})`,
    resourceType: 'Assessor',
    resourceId: updatedAssessor._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: oldData, new: assessorData },
  });

  return updatedAssessor;
};

const deleteAssessor = async (id, req) => {
  const assessor = await Assessor.findById(id);
  if (!assessor) throw new ApiError(404, 'Assessor not found');

  const start = Date.now();
  const snapshot = assessor.toObject();
  const deletedAssessor = await Assessor.findByIdAndDelete(id);

  await writeAuditLog(req, {
    action: 'DELETE',
    module: 'Assessor',
    actionDescription: `Deleted assessor account for ${snapshot.email} (ID: ${id})`,
    resourceType: 'Assessor',
    resourceId: id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: snapshot, new: null },
  });

  return deletedAssessor;
};

const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await Assessor.findOne({ email });

  if (!user || !(await !(await user.isPasswordMatch(password)))) {
    throw new ApiError(401, 'Invalid email or password');
  }
  return user;
};

const getApprovedClaims = async (assessorId) => {
  const assessor = await Assessor.findById(assessorId);
  if (!assessor) throw new Error('Assessor not found');

  const asseslatitude = assessor.location.latitude
  const asseslongitude = assessor.location.longitude;
  if (!asseslatitude || !asseslongitude) {
    throw new Error('Assessor location coordinates are missing');
  }

  const claims = await Claim.find({
    status: 'Approved',
    awardedAssessor: { $exists: false }
  });
  // Filter claims based on proximity to the assessor's location
  const nearbyClaims = claims.filter((claim) => {
    const { latitude, longitude } = claim.incidentDetails;

    if (!latitude || !longitude) return false;

    const distance = getDistanceFromLatLonInKm(
      asseslatitude,
      asseslongitude,
      latitude,
      longitude
    );
    console.log("distance", distance)

    return distance <= 50;
  });

  return nearbyClaims;
};
const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
    Math.cos(degToRad(lat2)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
};

const degToRad = (deg) => (deg * Math.PI) / 180;

const placeBid = async (claimId, assessorId, amount, description, timeline, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, 'Claim not found');

  if (claim.status !== 'Approved') throw new ApiError(400, 'Bids can only be placed on approved claims');

  const existingBid = claim.bids.find((bid) => bid.assessorId?.toString() === assessorId);
  if (existingBid) throw new ApiError(400, 'You have already placed a bid on this claim');

  const assessor = await Assessor.findById(assessorId);
  if (!assessor) throw new ApiError(404, 'Assessor not found');
  const pendingWork = await Claim.countDocuments({
    'awardedAssessor.assessorId': assessorId,
    status: { $ne: 'Completed' },
  });

  const newBid = {
    bidderType: 'assessor',
    ratings: assessor.ratings.averageRating,
    assessorId,
    amount,
    description,
    timeline,
    assessorDetails: {
      pendingWork,
      ratings: assessor.ratings,
      location: assessor.location,
    },
    bidDate: new Date(),
    status: 'pending',
  };
  claim.bids.push(newBid);

  const start = Date.now();
  await claim.save();

  await writeAuditLog(req, {
    action: 'CREATE',
    module: 'Claim',
    actionDescription: `Assessor placed bid of ${amount} on claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claimId,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: newBid },
  });

  return {
    amount,
    description,
    timeline,
    assessorDetails: {
      name: assessor.name,
      ratings: assessor.ratings,
      location: assessor.location,
    },
    pendingWork,
  };
};


const getAssessorBids = async (assessorId) => {
  const claims = await Claim.find({ "bids.assessorId": assessorId });

  const assessorBids = [];
  for (const claim of claims) {
    const relevantBids = claim.bids.filter((bid) => bid.assessorId?.toString() === assessorId);
    relevantBids.forEach((bid) => {
      assessorBids.push({
        claimId: claim._id,
        bidId: bid._id,
        amount: bid.amount,
        status: bid.status,
        bidDate: bid.bidDate,
        claimStatus: claim.status,
        vehicleType: claim.vehiclesInvolved?.[0] || 'Unknown'
      });
    });
  }

  if (assessorBids.length === 0) throw new ApiError(404, 'No bids found for this assessor');
  return assessorBids;
};

const submitAssessmentReport = async (claimId, assessmentReport, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, 'Claim not found');

  const parts = assessmentReport.parts.map((part) => {
    return { partName: part, cost: '' };
  });
  assessmentReport.parts = parts;

  const start = Date.now();
  claim.assessmentReport = assessmentReport;
  claim.status = 'Assessed';
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Submitted assessment report for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Assessment' }, new: { status: 'Assessed', assessmentReport } },
  });

  return claim;
};

const resetPassword = async (email, newPassword, req) => {
  const user = await Assessor.findOne({ email });
  if (!user) throw new Error('Invalid request');

  const start = Date.now();
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();

  await writeAuditLog(req, {
    action: 'RESET_PASSWORD',
    module: 'Assessor',
    actionDescription: `Password reset for assessor ${email}`,
    resourceType: 'Assessor',
    resourceId: user._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: '[PASSWORD CHANGED]' },
  });

  return { message: 'Password has been reset successfully' };
};

const completeRepair = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Re-Assessment') throw new Error('Claim must be under Re-Assessment to mark it as Completed');

  const start = Date.now();
  claim.status = 'Completed';
  claim.repairDate = new Date();
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Marked repair as completed for claim ${claimId}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Re-Assessment' }, new: { status: 'Completed', repairDate: claim.repairDate } },
  });

  if (!claim.selfRepair.opted && claim.awardedGarage && claim.awardedGarage.garageId) {
    const garage = await Garage.findById(claim.awardedGarage.garageId);
    garage.pendingWork -= 1;
    await garage.save();
  }
  
  

  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Repair Completed - Verification Pending',
      `Dear ${claim.claimant.name},

We are pleased to inform you that the repair for your claim with ID: ${claim.vehiclesInvolved[0].licensePlate} has been completed.
Please verify that the vehicle has been fully repaired.
If you are satisfied with the repair, please reply to this email to confirm.
Thank you for your patience during this process.

Best Regards,
Admin Team`
    );
  }
  return claim;
};
const rejectRepair = async (claimId, rejectionReason, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Re-Assessment') throw new Error('Claim must be under Re-Assessment to mark it as Rejected');

  const start = Date.now();
  claim.status = 'Repair';
  const garage = await Garage.findById(claim.awardedGarage.garageId);
  await emailService.sendEmailNotification(
    garage.email,
    'Repair Rejected ',
    `Dear ${garage.name},
    Your repair for claim with ID: ${claim.vehiclesInvolved[0].licensePlate} has been rejected due to ${rejectionReason}. Please contact the Assessor to discuss further.
    Thank you for your cooperation.
    Best Regards,
    Admin Team`
    );

  claim.rejectionReason = rejectionReason;
  await claim.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Rejected repair for claim ${claimId}: ${rejectionReason}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Re-Assessment' }, new: { status: 'Repair', rejectionReason } },
  });

  return claim;
};
// Assessor statistics for the admin dashboard
const getAssessorStatistics = async () => {
  const totalAssessors = await Assessor.countDocuments();
  const busyAssessors = await Assessor.countDocuments({ "ratings.totalRatings": { $gt: 0 } });
  const freeAssessors = totalAssessors - busyAssessors;

  return {
    totalAssessors,
    busyAssessors,
    freeAssessors
  };
};

const getTopAssessors = async () => {
  const topAssessors = await Assessor.aggregate([
    {
      $lookup: {
        from: 'claims',
        localField: '_id',
        foreignField: 'awardedAssessor.assessorId',
        as: 'claims',
      },
    },
    {
      $project: {
        name: 1,
        'ratings.averageRating': 1,
        totalClaimsAssessed: { $size: '$claims' },
      },
    },
    { $sort: { totalClaimsAssessed: -1 } },
    { $limit: 10 },
  ]);
  return topAssessors;
}

  







module.exports = {
  createAssessor,
  getAssessors,
  getAssessorById,
  updateAssessor,
  deleteAssessor,
  loginUserWithEmailAndPassword,
  getApprovedClaims,
  placeBid,
  getAssessorBids,
  submitAssessmentReport,
  resetPassword,
  completeRepair,
  rejectRepair,
  getAssessorStatistics,
  getTopAssessors
};
