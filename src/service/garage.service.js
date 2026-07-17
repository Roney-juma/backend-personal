const Garage = require('../models/garage.model');
const Claim = require('../models/claim.model');
const Assessor = require('../models/assessor.model');
const ApiError = require('../utils/ApiError');
const customerModel = require("../models/customerModel");
const bcrypt = require('bcrypt');
const { createResetToken, verifyResetToken, resetEmailBody } = require("../utils/passwordReset");
const { isLocked, registerFailedAttempt, resetAttempts, AccountLockedError } = require("../utils/accountLockout");
const { assertValidPassword } = require("../utils/passwordPolicy");
const { DEFAULT_TEMP_PASSWORD } = require("../constants/userDefaults");
const emailService = require("./email.service");
const whatsappService = require('./whatsapp.service');
const tokenService = require("./token.service");
const SupplyBid = require('../models/supplyBids.model');
const cache = require('../cache');
const logger = require('../middlewheres/logger');

const createGarage = async (garage) => {
  const existingGarage = await Garage.findOne({ email: garage.email });
  const existingCustomer = await customerModel.findOne({ email: garage.email });
  // const existingAssessor = await Assessor.findOne({ email: garage.email });
  if (existingGarage || existingCustomer) {
    throw new Error('We Already have a user with this Email');
  }

  // Admin-created: default temporary password + forced change on first login.
  const plainPassword = garage.password || DEFAULT_TEMP_PASSWORD;
  garage.password = await bcrypt.hash(plainPassword, 10);
  garage.mustChangePassword = true;

  // Create and save the new Garage. Admin sets the initial password, so require
  // a change on first login (forced-override so the client can't opt out).
  const newGarage = new Garage({ ...garage, mustChangePassword: true });
  const savedGarage = await newGarage.save();
  await cache.del('cache:stats:garages', 'cache:garages:top');
  await cache.delPattern('cache:garages:all:*');

  if (savedGarage && savedGarage.email) {
    await emailService.sendEmailNotification(
      savedGarage.email,
      'Welcome to Ave Insurance - Your New Account Details',
      `Dear ${savedGarage.name},

We are delighted to welcome you to Ave Insurance! Your new account has been successfully created.

Here are your login details:

- Email: ${savedGarage.email}
- Temporary password: ${plainPassword}

For your security, you will be asked to set a new password the first time you log in.

Thank you for choosing Ave Insurance.

Best Regards,
Admin Team`
    );
  }
  if (savedGarage && savedGarage.contactNumber) {
    await whatsappService.sendWhatsAppMessage(
      savedGarage.contactNumber,
      `Hi ${savedGarage.name}, welcome to Ave Insurance! Your garage account has been created. Log in with your registered email to start receiving claim assignments. — Ave Insurance`
    );
  }

  return savedGarage;
};

const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await Garage.findOne({ email });
  if (!user) return null;

  if (isLocked(user)) {
    throw new AccountLockedError(user);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    await registerFailedAttempt(user);
    return null;
  }

  await resetAttempts(user);
  return user;
};

const getAllGarages = async (filter = {}, page = 1, limit = 10) => {
  const key = `cache:garages:all:${page}:${limit}:${JSON.stringify(filter)}`;
  return cache.wrap(key, async () => {
    try {
      const query = {};
      if (filter.company) query.company = filter.company;
      if (filter.city) query.location.city = filter.city;
      if (filter.estate) query.location.estate = filter.estate;
      if (filter.state) query.location.state = filter.state;

      const totalGarages = await Garage.countDocuments(query);
      const garages = await Garage.find(query)
        .skip((page - 1) * limit)
        .limit(limit);

      return { garages, totalGarages, currentPage: page, totalPages: Math.ceil(totalGarages / limit) };
    } catch (error) {
      throw error;
    }
  }, 1800);
};

const getGarage = async (garageId) => {
  return cache.wrap(`cache:garage:${garageId}`, () => Garage.findById(garageId), 1800);
};

const updateGarage = async (garageId, updateData, company) => {
  // Scope to the requester's company (staff → no scope). Strip company from the
  // payload so a company user can't reassign a garage to another tenant.
  const filter = { _id: garageId, ...(company ? { company } : {}) };
  if (company) delete updateData.company;
  const result = await Garage.findOneAndUpdate(filter, updateData, { new: true });
  await cache.del(`cache:garage:${garageId}`, 'cache:stats:garages', 'cache:garages:top');
  await cache.delPattern('cache:garages:all:*');
  return result;
};

const deleteGarage = async (garageId, company) => {
  const filter = { _id: garageId, ...(company ? { company } : {}) };

  // Integrity guard: refuse to delete a garage that is mid-repair. A hard delete
  // would leave a dangling awardedGarage reference on a live claim.
  const activeClaims = await Claim.countDocuments({
    'awardedGarage.garageId': garageId,
    status: { $nin: ['Completed', 'Rejected'] },
  });
  if (activeClaims > 0) {
    throw new ApiError(
      409,
      `Cannot delete this garage: it is assigned to ${activeClaims} active claim(s). Reassign or complete those claims first.`
    );
  }

  const result = await Garage.softDeleteOne(filter);

  if (result) {
    // Remove any leftover pending bids so they can't be auto-awarded to a
    // deleted garage. Awarded/rejected bids are kept for history.
    await Claim.updateMany(
      { 'bids.garageId': garageId },
      { $pull: { bids: { garageId, status: 'pending' } } }
    );
    await cache.del(`cache:garage:assessed-claims:${garageId}`, `cache:garage:bids:${garageId}`);
  }

  await cache.del(`cache:garage:${garageId}`, 'cache:stats:garages', 'cache:garages:top');
  await cache.delPattern('cache:garages:all:*');
  return result;
};

const getAssessedClaims = async (garageId) => {
  return cache.wrap(`cache:garage:assessed-claims:${garageId}`, async () => {
    const garage = await Garage.findById(garageId);
    if (!garage) throw new Error('garage not found');

    const asseslatitude = garage.location.latitude;
    const asseslongitude = garage.location.longitude;
    if (!asseslatitude || !asseslongitude) {
      throw new Error('garage location coordinates are missing');
    }

    const claims = await Claim.find({ status: 'Garage', awardedGarage: { $exists: false } });
    const nearbyClaims = claims.filter((claim) => {
      const { latitude, longitude } = claim.incidentDetails;
      if (!latitude || !longitude) return false;
      const distance = getDistanceFromLatLonInKm(asseslatitude, asseslongitude, latitude, longitude);
      return distance <= 20;
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

const placeBid = async (claimId, garageId, description, timeline, parts) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');

  if (claim.status !== 'Garage') {
    throw new Error('Bids can only be placed on Garage claims');
  }

  const existingBid = claim.bids.find(
    (bid) => bid.garageId && bid.garageId.toString() === garageId
  );
  if (existingBid) {
    throw new Error('You have already placed a bid on this claim');
  }
  const totalCost = parts.reduce((total, part) => total + part.cost, 0);
  const garage = await Garage.findById(garageId);

  const acceptedSupplyBid = await SupplyBid.findOne({ claimId, status: 'Accepted' });

  const newBid = {
    bidderType: 'garage',
    ratings: garage.ratings.averageRating,
    garageDetails: {
      name: garage.name,
      pendingWork: garage.pendingWork,
      ratings: garage.ratings,
      location: garage.location,
    },
    garageId,
    awardedSupplierId: acceptedSupplyBid?.supplierId || null,
    parts,
    timeline,
    description,
    totalCost,
    bidDate: new Date(),
    status: 'pending',
  };
  claim.bids.push(newBid);
  await claim.save();
  await cache.del(`cache:garage:bids:${garageId}`);
  await cache.delPattern('cache:claims:*');

  // Fire-and-forget — response doesn't depend on notification delivery.
  if (garage && garage.email) {
    emailService.sendEmailNotification(
      garage.email,
      'New Bid Placed',
      `Dear ${garage.name},\n\nYou have successfully placed a bid of ${totalCost} on claim ID: ${claim._id}. The following parts are included in your bid:\n\n${parts
        .map((part) => `${part.partName}: ${part.cost}`)
        .join('\n')}\n\nThank you for your participation.`
    ).catch(err => logger.warn(`Garage bid email failed for claim ${claim._id}: ${err.message}`));
  }
  if (garage && garage.contactNumber) {
    whatsappService.sendWhatsAppMessage(
      garage.contactNumber,
      `Hi ${garage.name}, your bid of R${totalCost} on claim ${claim._id} has been placed successfully. We'll notify you of the outcome. — Ave Insurance`
    ).catch(err => logger.warn(`Garage bid WhatsApp failed for claim ${claim._id}: ${err.message}`));
  }

  // Auto-award if this bid completes the threshold (>3 pending garage bids). Runs in the
  // background; previously this only happened lazily on the claims-list read.
  require('./claim.service').runAutoAward(claimId)
    .catch(err => logger.warn(`Auto-award after garage bid failed for claim ${claimId}: ${err.message}`));

  const response = {
    claim,
    garageDetails: {
      pendingWork: garage.pendingWork,
      ratings: garage.ratings,
      location: garage.location,
    },
  };

  return response;
};

// Call for Re-Assessment — garage submits repair report at the same time
const callForReAssessment = async (claimId, garageId, report = {}) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'Repair') throw new Error('Claim must be in Repair to call for re-assessment');

  claim.garageRepairReport = {
    garageId: garageId || null,
    workDone: report.workDone || '',
    vehicleCondition: report.vehicleCondition || '',
    partsSalvaged: Array.isArray(report.partsSalvaged) ? report.partsSalvaged : [],
    partsReplaced: Array.isArray(report.partsReplaced) ? report.partsReplaced : [],
    receipts: Array.isArray(report.receipts) ? report.receipts : [],
    photos: Array.isArray(report.photos) ? report.photos : [],
    totalRepairCost: report.totalRepairCost ? Number(report.totalRepairCost) : null,
    submittedAt: new Date(),
  };
  claim.status = 'Re-Assessment';
  claim.repairDate = new Date();
  await claim.save();
  await cache.delPattern('cache:claims:*');
  await cache.del(`cache:claim:${claimId}`);
  if (claim.awardedAssessor && claim.awardedAssessor.assessorId) {
    const assessor = await Assessor.findById(claim.awardedAssessor.assessorId);
    const raVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
    if (assessor && assessor.email) {
      await emailService.sendEmailNotification(
        assessor.email,
        'Re-Assessment Required - Repair Completed',
        `Dear ${assessor.name},

The repair for the claim with ID: ${raVehicle} has been completed. Please visit the location to verify that the vehicle has been fully repaired.

Thank you for your prompt attention to this matter.

Best Regards,
Admin Team`
      );
    }
    if (assessor && assessor.contactInfo?.phone) {
      await whatsappService.sendWhatsAppMessage(
        assessor.contactInfo.phone,
        `Hi ${assessor.name}, re-assessment required for claim ${raVehicle}. The garage has completed the repair — please visit to verify. — Ave Insurance`
      );
    }
  }

  return claim;
};

const getGarageBids = async (garageId) => {
  if (!garageId) throw new Error('garageId is required');
  return cache.wrap(`cache:garage:bids:${garageId}`, async () => {
  const garageIdStr = garageId.toString();

  const claims = await Claim.find({
    $or: [
      { 'bids.bidderType': 'garage', 'bids.garageId': garageId },
      { 'awardedGarage.garageId': garageId },
    ],
  });

  const garageBids = [];

  claims.forEach((claim) => {
    const filteredBids = claim.bids.filter(
      (bid) => bid.bidderType === 'garage' && bid.garageId?.toString() === garageIdStr
    );

    filteredBids.forEach((bid) => {
      garageBids.push({
        claimId: claim._id,
        bidId: bid._id,
        amount: bid.amount,
        status: bid.status,
        bidDate: bid.bidDate,
        claimStatus: claim.status,
        vehicleType: claim.vehiclesInvolved?.[0] || 'Unknown',
        supplierId: bid.awardedSupplierId || null,
      });
    });

    if (claim.awardedGarage?.garageId?.toString() === garageIdStr) {
      garageBids.push({
        claimId: claim._id,
        bidId: null,
        amount: claim.awardedGarage.awardedAmount,
        status: 'awarded',
        bidDate: claim.awardedGarage.awardedDate,
        claimStatus: claim.status,
        vehicleType: claim.vehiclesInvolved?.[0] || 'Unknown',
      });
    }
  });

  return garageBids;
  }, 600);
};

const forgotPassword = async (email) => {
  const user = await Garage.findOne({ email });
  // Always return the same response so the endpoint cannot be used to enumerate accounts.
  if (user) {
    const { rawToken, hashedToken, expires } = await createResetToken();
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = expires;
    await user.save();

    await emailService.sendEmailNotification(
      user.email,
      'Your Ave Insurance password reset code',
      resetEmailBody(user.name, rawToken)
    );
  }
  return { message: 'If an account exists for that email, a reset link has been sent.' };
};

const resetPassword = async (email, token, newPassword) => {
  const user = await Garage.findOne({ email });
  if (!user || !(await verifyResetToken(token, user))) {
    throw new Error('Reset token is invalid or has expired');
  }

  assertValidPassword(newPassword);
  user.password = await bcrypt.hash(newPassword, 10);

  // Invalidate the token so it can only be used once.
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  await user.save();

  return { message: 'Password has been reset successfully' };
};

// Garage stats include  count, pendingWork and averageRating
const getGarageStats = async () => {
  return cache.wrap('cache:stats:garages', async () => {
    const garagesCount = await Garage.countDocuments();
    const pendingWorkCount = await Garage.countDocuments({ pendingWork: { $gt: 0 } });
    const averageRating = await Garage.aggregate([
      { $group: { _id: null, averageRating: { $avg: '$ratings.averageRating' } } },
    ]);
    return { garagesCount, pendingWorkCount, averageRating: averageRating[0]?.averageRating || 0 };
  }, 1800);
};
// Top 10 garages with highest number of claims awarded
const getTopGarages = async () => {
  return cache.wrap('cache:garages:top', () => Garage.aggregate([
    {
      $lookup: {
        from: 'claims',
        localField: '_id',
        foreignField: 'awardedGarage.garageId',
        as: 'claims',
      },
    },
    {
      $project: {
        name: 1,
        pendingWork: 1,
        'ratings.averageRating': 1,
        totalClaimsRepaired: { $size: '$claims' },
      },
    },
    { $sort: { totalClaimsRepaired: -1 } },
    { $limit: 10 },
  ]), 3600);
}


module.exports = {
  createGarage,
  loginUserWithEmailAndPassword,
  getAllGarages,
  getGarage,
  updateGarage,
  deleteGarage,
  getAssessedClaims,
  placeBid,
  callForReAssessment,
  getGarageBids,
  forgotPassword,
  resetPassword,
  getGarageStats,
  getTopGarages
};
