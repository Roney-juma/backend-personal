const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const bcrypt = require('bcrypt');
const Claim = require('../models/claim.model');
const ApiError = require('../utils/ApiError');
const emailService = require("../service/email.service");
const whatsappService = require('./whatsapp.service');
const { writeAuditLog } = require('../utils/auditHelper');
const cache = require('../cache');
const { getAnalyzeQueue } = require('../queue/queues');
const logger = require('../middlewheres/logger');



const createAssessor = async (assessorData, req) => {
  const existingUser = await Assessor.findOne({ email: assessorData.email });
  if (existingUser) throw new ApiError(409, 'Assessor already exists');

  const start = Date.now();
  const safeData = { ...assessorData };
  delete safeData.password;

  safeData.password = await bcrypt.hash(assessorData.password, 10);
  assessorData.password = safeData.password;
  const newAssessor = await Assessor.create(assessorData);
  await cache.del('cache:assessors:all', 'cache:stats:assessors', 'cache:assessors:top');

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
  return cache.wrap('cache:assessors:all', () => Assessor.find(), 1800);
};

const getAssessorById = async (id) => {
  return cache.wrap(`cache:assessor:${id}`, async () => {
    const assessor = await Assessor.findById(id);
    if (!assessor) throw new ApiError(404, 'Assessor not found');
    return assessor;
  }, 1800);
};

const updateAssessor = async (id, assessorData, req) => {
  const assessor = await Assessor.findById(id);
  if (!assessor) throw new ApiError(404, 'Assessor not found');

  const start = Date.now();
  const oldData = assessor.toObject();
  const updatedAssessor = await Assessor.findByIdAndUpdate(id, assessorData, { new: true });
  await cache.del('cache:assessors:all', `cache:assessor:${id}`, 'cache:stats:assessors', 'cache:assessors:top');

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
  await cache.del('cache:assessors:all', `cache:assessor:${id}`, 'cache:stats:assessors', 'cache:assessors:top');

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
  return cache.wrap(`cache:assessor:approved-claims:${assessorId}`, async () => {
    const assessor = await Assessor.findById(assessorId);
    if (!assessor) throw new Error('Assessor not found');

    const asseslatitude = assessor.location.latitude;
    const asseslongitude = assessor.location.longitude;
    if (!asseslatitude || !asseslongitude) {
      throw new Error('Assessor location coordinates are missing');
    }

    const claims = await Claim.find({
      status: 'Approved',
      awardedAssessor: { $exists: false }
    });
    const nearbyClaims = claims.filter((claim) => {
      const { latitude, longitude } = claim.incidentDetails;
      if (!latitude || !longitude) return false;
      const distance = getDistanceFromLatLonInKm(asseslatitude, asseslongitude, latitude, longitude);
      return distance <= 50;
    });

    return nearbyClaims;
  }, 300);
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
  await cache.del(`cache:assessor:bids:${assessorId}`);
  await cache.delPattern('cache:claims:*');

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
  return cache.wrap(`cache:assessor:bids:${assessorId}`, async () => {
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
          vehicleType: claim.vehiclesInvolved?.[0] || 'Unknown',
          selfRepair: claim.selfRepair?.opted ? { status: claim.selfRepair.status, opted: claim.selfRepair.opted } : null,
        });
      });
    }

    if (assessorBids.length === 0) throw new ApiError(404, 'No bids found for this assessor');
    return assessorBids;
  }, 600);
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
  await cache.delPattern('cache:claims:*');
  await cache.del(`cache:claim:${claimId}`);

  // Re-run fraud pipeline now that assessor photos are available
  const analyzeQueue = getAnalyzeQueue();
  if (analyzeQueue) {
    analyzeQueue.add('analyze', { claimId: claim._id.toString() }).catch(err =>
      logger.warn(`Failed to re-enqueue analysis after assessment for ${claim._id}: ${err.message}`)
    );
  }

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

const submitReAssessmentReport = async (claimId, { notes, photos, outcome, assessorId }, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Re-Assessment') throw new Error('Claim must be under Re-Assessment to submit a report');
  if (!notes || !notes.trim()) throw new Error('Notes are required');
  if (!outcome || !['Passed', 'Failed'].includes(outcome)) throw new Error('outcome must be Passed or Failed');

  const start = Date.now();
  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;

  claim.reAssessmentReport = {
    notes: notes.trim(),
    photos: Array.isArray(photos) ? photos : [],
    outcome,
    assessorId: assessorId || null,
    submittedAt: new Date(),
  };

  if (outcome === 'Passed') {
    claim.status = 'ReAssessed';
  } else {
    // Failed — return directly to Repair and notify garage
    claim.status = 'Repair';

    if (claim.awardedGarage?.garageId) {
      const garage = await Garage.findById(claim.awardedGarage.garageId);
      if (garage?.email) {
        await emailService.sendEmailNotification(
          garage.email,
          'Re-Assessment Failed — Further Repair Required',
          `Dear ${garage.name},

The re-assessment for vehicle (${vehicle}) has been marked as Failed.

Assessor notes: ${notes.trim()}

Please review the issues and complete the outstanding repair work. Once done, resubmit for re-assessment.

Best Regards,
Admin Team`
        );
      }
      if (garage?.contactNumber) {
        await whatsappService.sendWhatsAppMessage(
          garage.contactNumber,
          `Hi ${garage.name}, the re-assessment for vehicle (${vehicle}) has *failed*.\n\nNotes: ${notes.trim()}\n\nPlease fix the outstanding issues and resubmit for re-assessment. — Ave Insurance`
        );
      }
    }

    if (claim.claimant?.email) {
      await emailService.sendEmailNotification(
        claim.claimant.email,
        'Repair Re-Assessment — Further Work Required',
        `Dear ${claim.claimant.name},

Following the re-assessment of your vehicle (${vehicle}), our assessor has identified outstanding issues that require further attention from the garage.

We have notified the garage and they will be in contact to arrange the additional work. We apologise for the inconvenience.

Best Regards,
Admin Team`
      );
    }
    if (claim.claimant?.phone) {
      await whatsappService.sendWhatsAppMessage(
        claim.claimant.phone,
        `Hi ${claim.claimant.name}, the re-assessment of your vehicle (${vehicle}) found outstanding issues. The garage has been notified to complete the remaining work. We'll keep you updated. — Ave Insurance`
      );
    }
  }

  await claim.save();
  await cache.delPattern('cache:claims:*');
  await cache.del(`cache:claim:${claimId}`);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Assessor submitted re-assessment report for claim ${claimId} — outcome: ${outcome}`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Re-Assessment' }, new: { status: claim.status, outcome } },
  });

  return claim;
};

const completeRepair = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'ReAssessed') throw new Error('Re-assessment must be submitted and passed before completing');
  if (claim.reAssessmentReport?.outcome !== 'Passed') throw new Error('Re-assessment outcome is not Passed — cannot complete');

  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  const start = Date.now();

  claim.status = 'Completed';
  claim.repairDate = new Date();
  await claim.save();
  await cache.delPattern('cache:claims:*');
  await cache.del(`cache:claim:${claimId}`);

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Admin completed claim ${claimId} following passed re-assessment`,
    resourceType: 'Claim',
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'ReAssessed' }, new: { status: 'Completed' } },
  });

  if (!claim.selfRepair?.opted && claim.awardedGarage?.garageId) {
    const garage = await Garage.findById(claim.awardedGarage.garageId);
    if (garage) { garage.pendingWork = Math.max(0, (garage.pendingWork || 1) - 1); await garage.save(); }
  }

  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Repair Verified & Claim Closed',
      `Dear ${claim.claimant.name},

We are pleased to inform you that the repair of your vehicle (${vehicle}) has been independently verified by our assessor and confirmed as satisfactory.

Your claim is now closed.

Thank you for choosing Ave Insurance.

Best Regards,
Admin Team`
    );
  }
  if (claim.claimant?.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name}, great news! The repair of your vehicle (${vehicle}) has been verified and your claim is now *closed*. Thank you for choosing Ave Insurance.`
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
  const rrVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  const garage = await Garage.findById(claim.awardedGarage.garageId);
  if (garage && garage.email) {
    await emailService.sendEmailNotification(
      garage.email,
      'Repair Rejected',
      `Dear ${garage.name},\n    Your repair for claim with ID: ${rrVehicle} has been rejected due to ${rejectionReason}. Please contact the Assessor to discuss further.\n    Thank you for your cooperation.\n    Best Regards,\n    Admin Team`
    );
  }
  if (garage && garage.contactNumber) {
    await whatsappService.sendWhatsAppMessage(
      garage.contactNumber,
      `Hi ${garage.name}, the repair for claim ${rrVehicle} has been *rejected*.\nReason: ${rejectionReason}\n\nPlease contact the assessor to discuss. — Ave Insurance`
    );
  }

  claim.rejectionReason = rejectionReason;
  await claim.save();
  await cache.delPattern('cache:claims:*');
  await cache.del(`cache:claim:${claimId}`);

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
  return cache.wrap('cache:stats:assessors', async () => {
    const totalAssessors = await Assessor.countDocuments();
    const busyAssessors = await Assessor.countDocuments({ "ratings.totalRatings": { $gt: 0 } });
    const freeAssessors = totalAssessors - busyAssessors;
    return { totalAssessors, busyAssessors, freeAssessors };
  }, 1800);
};

const getTopAssessors = async () => {
  return cache.wrap('cache:assessors:top', () => Assessor.aggregate([
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
  ]), 3600);
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
  submitReAssessmentReport,
  resetPassword,
  completeRepair,
  rejectRepair,
  getAssessorStatistics,
  getTopAssessors
};
