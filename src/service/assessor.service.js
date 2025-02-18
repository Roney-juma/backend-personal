const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const bcrypt = require('bcrypt');
const Claim = require('../models/claim.model');
const logAudit = require('../models/audit.model')
const ApiError = require('../utils/ApiError');
const emailService = require("../service/email.service");



const createAssessor = async (assessorData, userId) => {
  const existingUser = await Assessor.findOne({ email: assessorData.email });
  if (existingUser) throw new ApiError(409, 'Assessor already exists');

  assessorData.password = await bcrypt.hash(assessorData.password, 10);
  const newAssessor = await Assessor.create(assessorData);
  const audit = new logAudit({
    userId: userId,
    action: "Created Assessor",
    collectionName: "Assessor",
    documentId: newAssessor._id,
    changes: { old: null, new: assessorData }
    });
    await audit.save();

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

const updateAssessor = async (id, assessorData, userId) => {
  console.log("Ids",id, assessorData, userId )
  const assessor = await Assessor.findById(id);
  if (!assessor) throw new ApiError(404, 'Assessor not found');

  const oldData = { ...assessor.toObject() };
  const updatedAssessor = await Assessor.findByIdAndUpdate(id, assessorData, { new: true });
  const audit = new logAudit({
    action: "UPDATED",
    collectionName: "Assessor",
    documentId: updatedAssessor._id,
    changes: { old: oldData, new: assessorData },
    userId: userId
    });
    await audit.save();

  return updatedAssessor;
};

const deleteAssessor = async (id, userId) => {
  const assessor = await Assessor.findById(id);
  if (!assessor) throw new ApiError(404, 'Assessor not found');

  const deletedAssessor = await Assessor.findByIdAndDelete(id);

  // Log the deletion
  const audit = new logAudit({
    action: "DELETED",
    collectionName: "Assessor",
    documentId: deletedAssessor._id,
    changes: {  new:  assessor.toObject() },
    userId: userId
    });
    await audit.save();

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
  if (!asseslatitude || !asseslatitude || !asseslongitude) {
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

    return distance <= 20;
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

const placeBid = async (claimId, assessorId, amount, description, timeline, userId) => {
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

  await claim.save();

  const audit = new logAudit({
    action: "CREATE",
    collectionName: "Bid",
    documentId: newBid._id,
    changes: {  new:  newBid },
    userId: userId
    });
    await audit.save();

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
      });
    });
  }

  if (assessorBids.length === 0) throw new ApiError(404, 'No bids found for this assessor');
  return assessorBids;
};

const submitAssessmentReport = async (claimId, assessmentReport, userId) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, 'Claim not found');

  const parts = assessmentReport.parts.map((part) => {
    return { partName: part, cost: '' };
  });
  assessmentReport.parts = parts;

  claim.assessmentReport = assessmentReport;
  claim.status = 'Assessed';
  await claim.save();

  const audit = new logAudit({
    action: "UPDATE",
    collectionName: "Claim",
    documentId: claim._id,
    changes: {  new: 'Assessment Report Submitted' },
    userId: userId
    });
    await audit.save();

  return claim;
};

const resetPassword = async (email, newPassword, userId) => {
  const user = await Assessor.findOne({ email });
  if (!user) throw new Error('Invalid request');

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  user.password = hashedPassword;

  // Log the password reset
  const audit = new logAudit({
    action: "UPDATE",
    collectionName: "Assessor",
    documentId: user._id,
    changes: {  new: 'Password Reset' },
    userId: userId
    });
    await audit.save();

  await user.save();
  return { message: 'Password has been reset successfully' };
};

const completeRepair = async (claimId, userId) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Re-Assessment') throw new Error('Claim must be under Re-Assessment to mark it as Completed');

  claim.status = 'Completed';
  claim.repairDate = new Date();
  await claim.save();

  // Log the repair completion
  const audit = new logAudit({
    action: "UPDATE",
    collectionName: "Claim",
    documentId: claim._id,
    changes: {  new: 'Repair Completed' },
    userId: userId
    });
    await audit.save();

  // Get garage and reduce their pending repairs
  const garage = await Garage.findById(claim.awardedGarage.garageId);
  garage.pendingWork -= 1;
  await garage.save();

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
const rejectRepair = async (claimId, rejectionReason, userId) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Re-Assessment') throw new Error('Claim must be under Re-Assessment to mark it as Rejected');

  claim.status = 'Repair';
  claim.rejectionReason = rejectionReason;
  await claim.save();

  // Log the repair rejection
  const audit = new logAudit({
    action: "UPDATE",
    collectionName: "Claim",
    documentId: claim._id,
    changes: {  new: 'Rejected Repair' },
    userId: userId
    });
    await audit.save();

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
