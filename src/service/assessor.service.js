const mongoose = require("mongoose");
const Assessor = require("../models/assessor.model");
const Garage = require("../models/garage.model");
const bcrypt = require("bcrypt");
const Claim = require("../models/claim.model");
const ApiError = require("../utils/ApiError");
const {
  isLocked,
  registerFailedAttempt,
  resetAttempts,
  AccountLockedError,
} = require("../utils/accountLockout");
const {
  createResetToken,
  verifyResetToken,
  resetEmailBody,
} = require("../utils/passwordReset");
const { assertValidPassword } = require("../utils/passwordPolicy");
const { DEFAULT_TEMP_PASSWORD } = require("../constants/userDefaults");
const emailService = require("./email.service");
const whatsappService = require("./whatsapp.service");
const { writeAuditLog } = require("../utils/auditHelper");
const cache = require("../cache");
const { resolveLocation } = require("../utils/geocode");
const { getAnalyzeQueue } = require("../queue/queues");
const { getCorrelationId } = require("../utils/requestContext");
const logger = require("../middlewheres/logger");

const createAssessor = async (assessorData, req) => {
  const existingUser = await Assessor.findOne({ email: assessorData.email });
  if (existingUser) throw new ApiError(409, "Assessor already exists");

  const start = Date.now();
  // Admin-created: default temporary password + forced change on first login.
  // The Assessor model's pre('save') hook hashes the password, so pass it plain
  // and do NOT hash here (double-hashing makes login impossible).
  assessorData.password = assessorData.password || DEFAULT_TEMP_PASSWORD;
  assessorData.mustChangePassword = true;
  const safeData = { ...assessorData };
  delete safeData.password;

  // Admin sets the initial password, so require a change on first login.
  const newAssessor = await Assessor.create({
    ...assessorData,
    mustChangePassword: true,
  });
  await cache.del("cache:assessors:all");
  await cache.delPattern("cache:stats:assessors:*");
  await cache.delPattern("cache:assessors:top:*");

  await writeAuditLog(req, {
    action: "CREATE",
    module: "Assessor",
    actionDescription: `Created assessor account for ${assessorData.email}`,
    resourceType: "Assessor",
    resourceId: newAssessor._id,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: safeData },
  });

  return newAssessor;
};
const getAssessors = async ({
  page = 1,
  limit = 10,
  search = "",
  company,
} = {}) => {
  const query = {};
  if (company) query.company = company;
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const p = Math.max(Number(page) || 1, 1);
  const l = Math.min(Math.max(Number(limit) || 10, 1), 100); // cap page size
  const skip = (p - 1) * l;

  const [assessors, total] = await Promise.all([
    Assessor.find(query).skip(skip).limit(l).sort({ createdAt: -1 }).lean(),
    Assessor.countDocuments(query),
  ]);

  return { assessors, total, page: p, limit: l, pages: Math.ceil(total / l) };
};

const getAssessorById = async (id) => {
  return cache.wrap(
    `cache:assessor:${id}`,
    async () => {
      const assessor = await Assessor.findById(id);
      if (!assessor) throw new ApiError(404, "Assessor not found");
      return assessor;
    },
    1800
  );
};

const updateAssessor = async (id, assessorData, req, company) => {
  // Scope to the requester's company (staff → no scope). Strip company from the
  // payload so a company user can't reassign an assessor to another tenant.
  const filter = { _id: id, ...(company ? { company } : {}) };
  if (company) delete assessorData.company;
  const assessor = await Assessor.findOne(filter);
  if (!assessor) throw new ApiError(404, "Assessor not found");

  const start = Date.now();
  const oldData = assessor.toObject();

  // Assessor matching is distance-based and hard-fails when coordinates are
  // missing, so re-derive them whenever the address text changes.
  if (assessorData.location) {
    const location = await resolveLocation(oldData.location, assessorData.location);
    if (location) assessorData.location = location;
  }
  const updatedAssessor = await Assessor.findOneAndUpdate(
    filter,
    assessorData,
    { new: true }
  );
  await cache.del("cache:assessors:all", `cache:assessor:${id}`);
  await cache.delPattern("cache:stats:assessors:*");
  await cache.delPattern("cache:assessors:top:*");

  await writeAuditLog(req, {
    action: "UPDATE",
    module: "Assessor",
    actionDescription: `Updated assessor profile (ID: ${id})`,
    resourceType: "Assessor",
    resourceId: updatedAssessor._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: oldData, new: assessorData },
  });

  return updatedAssessor;
};

const deleteAssessor = async (id, req, company) => {
  const filter = { _id: id, ...(company ? { company } : {}) };
  const assessor = await Assessor.findOne(filter);
  if (!assessor) throw new ApiError(404, "Assessor not found");

  // Integrity guard: refuse to delete an assessor who is mid-job. A hard delete
  // would leave a dangling awardedAssessor reference on a live claim (breaking
  // the claim view, audit trail and notifications).
  const activeClaims = await Claim.countDocuments({
    "awardedAssessor.assessorId": id,
    status: { $nin: ["Completed", "Rejected"] },
  });
  if (activeClaims > 0) {
    throw new ApiError(
      409,
      `Cannot delete this assessor: they are assigned to ${activeClaims} active claim(s). Reassign or complete those claims first.`
    );
  }

  const start = Date.now();
  const snapshot = assessor.toObject();
  const deletedAssessor = await Assessor.softDeleteOne(filter);

  // Remove any leftover pending bids so they can't be auto-awarded to a deleted
  // assessor. Awarded/rejected bids are kept for history (they carry the name).
  await Claim.updateMany(
    { "bids.assessorId": id },
    { $pull: { bids: { assessorId: id, status: "pending" } } }
  );

  await cache.del("cache:assessors:all", `cache:assessor:${id}`);
  await cache.delPattern("cache:stats:assessors:*");
  await cache.delPattern("cache:assessors:top:*");
  await cache.del(`cache:assessor:bids:${id}`);
  await cache.delPattern("cache:assessor:approved-claims:*");

  await writeAuditLog(req, {
    action: "DELETE",
    module: "Assessor",
    actionDescription: `Deleted assessor account for ${snapshot.email} (ID: ${id})`,
    resourceType: "Assessor",
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
  if (!user) {
    throw new ApiError(401, "Invalid email or password");
  }
  if (isLocked(user)) {
    throw new AccountLockedError(user);
  }
  if (!(await user.isPasswordMatch(password))) {
    await registerFailedAttempt(user);
    throw new ApiError(401, "Invalid email or password");
  }
  await resetAttempts(user);
  return user;
};

const getApprovedClaims = async (assessorId) => {
  return cache.wrap(
    `cache:assessor:approved-claims:${assessorId}`,
    async () => {
      const assessor = await Assessor.findById(assessorId);
      if (!assessor) throw new Error("Assessor not found");

      const asseslatitude = assessor.location.latitude;
      const asseslongitude = assessor.location.longitude;
      if (!asseslatitude || !asseslongitude) {
        throw new Error("Assessor location coordinates are missing");
      }

      // Tenant scope: assessors attached to an insurer only see that insurer's
      // claims. Legacy assessors without a company keep the old global feed.
      const claimFilter = {
        status: "Approved",
        awardedAssessor: { $exists: false },
      };
      if (assessor.company) claimFilter.company = assessor.company;
      const claims = await Claim.find(claimFilter).lean();
      const nearbyClaims = claims.filter((claim) => {
        const { latitude, longitude } = claim.incidentDetails;
        if (!latitude || !longitude) return false;
        const distance = getDistanceFromLatLonInKm(
          asseslatitude,
          asseslongitude,
          latitude,
          longitude
        );
        return distance <= 50;
      });

      return nearbyClaims;
    },
    300
  );
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

const placeBid = async (
  claimId,
  assessorId,
  amount,
  description,
  timeline,
  req
) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, "Claim not found");

  if (claim.status !== "Approved")
    throw new ApiError(400, "Bids can only be placed on approved claims");

  const existingBid = claim.bids.find(
    (bid) => bid.assessorId?.toString() === assessorId
  );
  if (existingBid)
    throw new ApiError(400, "You have already placed a bid on this claim");

  const assessor = await Assessor.findById(assessorId);
  if (!assessor) throw new ApiError(404, "Assessor not found");

  // Cross-tenant guard: an assessor may not bid on another insurer's claim.
  // Legacy actors/claims without a company are exempt.
  if (
    claim.company &&
    assessor.company &&
    String(claim.company) !== String(assessor.company)
  ) {
    throw new ApiError(
      403,
      "You cannot bid on a claim belonging to another insurance company"
    );
  }

  const pendingWork = await Claim.countDocuments({
    "awardedAssessor.assessorId": assessorId,
    status: { $ne: "Completed" },
  });

  const newBid = {
    bidderType: "assessor",
    ratings: assessor.ratings.averageRating,
    assessorId,
    amount,
    description,
    timeline,
    assessorDetails: {
      name: assessor.name,
      pendingWork,
      ratings: assessor.ratings,
      location: assessor.location,
    },
    bidDate: new Date(),
    status: "pending",
  };
  claim.bids.push(newBid);

  const start = Date.now();
  await claim.save();
  await cache.del(`cache:assessor:bids:${assessorId}`);
  // Singular key — `cache:claims:*` below does not cover it, and the admin's
  // claim detail is cached for 15 minutes.
  await cache.del(`cache:claim:${claimId}`);
  await cache.delPattern("cache:claims:*");
  // The assessor's "available claims" list is cached separately (5-min TTL) and
  // isn't covered by the patterns above, so a just-bid claim would linger in it.
  // Clear it so the claim disappears from the bidder's available list immediately.
  await cache.del(`cache:assessor:approved-claims:${assessorId}`);

  await writeAuditLog(req, {
    action: "CREATE",
    module: "Claim",
    actionDescription: `Assessor placed bid of ${amount} on claim ${claimId}`,
    resourceType: "Claim",
    resourceId: claimId,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: newBid },
  });

  // Auto-award if this bid completes the threshold. Runs in the background so the bidder's
  // response isn't blocked; previously this only happened lazily on the claims-list read.
  require("./claim.service")
    .runAutoAward(claimId)
    .catch((err) =>
      logger.warn(
        `Auto-award after assessor bid failed for claim ${claimId}: ${err.message}`
      )
    );

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
  return cache.wrap(
    `cache:assessor:bids:${assessorId}`,
    async () => {
      const claims = await Claim.find({ "bids.assessorId": assessorId }).lean();

      const assessorBids = [];
      for (const claim of claims) {
        const relevantBids = claim.bids.filter(
          (bid) => bid.assessorId?.toString() === assessorId
        );
        relevantBids.forEach((bid) => {
          assessorBids.push({
            claimId: claim._id,
            bidId: bid._id,
            amount: bid.amount,
            status: bid.status,
            bidDate: bid.bidDate,
            claimStatus: claim.status,
            vehicleType: claim.vehiclesInvolved?.[0] || "Unknown",
            selfRepair: claim.selfRepair?.opted
              ? {
                  status: claim.selfRepair.status,
                  opted: claim.selfRepair.opted,
                }
              : null,
          });
        });
      }

      if (assessorBids.length === 0)
        throw new ApiError(404, "No bids found for this assessor");
      return assessorBids;
    },
    600
  );
};

const submitAssessmentReport = async (claimId, assessmentReport, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, "Claim not found");

  // The formal report document (PDF/Word, uploaded via /images/upload-document)
  // is mandatory — mirrors the investigator's comprehensiveReport.
  if (
    !assessmentReport?.reportDocument?.url ||
    typeof assessmentReport.reportDocument.url !== "string"
  ) {
    throw new ApiError(
      400,
      "Assessment report document is required (reportDocument.url)"
    );
  }
  assessmentReport.reportDocument.uploadedAt = new Date();

  // Accept both shapes: legacy clients send plain strings, current ones
  // send { partName, cost } (previously objects got mangled into
  // { partName: {…}, cost: '' }, forcing display-side workarounds).
  const parts = (assessmentReport.parts || []).map((part) =>
    part && typeof part === "object"
      ? { partName: part.partName ?? part.name ?? "", cost: part.cost ?? "" }
      : { partName: part, cost: "" }
  );
  assessmentReport.parts = parts;

  const start = Date.now();
  claim.assessmentReport = assessmentReport;
  claim.status = "Assessed";
  await claim.save();
  await cache.delPattern("cache:claims:*");
  await cache.del(`cache:claim:${claimId}`);
  // The assessor's bids list is cached per-assessor (5-min TTL) and isn't covered above,
  // so the submitted report only reflected after the TTL. Clear it for the awarded assessor.
  const submittingAssessorId = claim.awardedAssessor?.assessorId;
  if (submittingAssessorId) {
    await cache.del(`cache:assessor:bids:${submittingAssessorId}`);
  }

  // Re-run fraud pipeline now that assessor photos are available
  const analyzeQueue = getAnalyzeQueue();
  if (analyzeQueue) {
    analyzeQueue
      .add("analyze", {
        claimId: claim._id.toString(),
        correlationId: getCorrelationId(),
      })
      .catch((err) =>
        logger.warn(
          `Failed to re-enqueue analysis after assessment for ${claim._id}: ${err.message}`
        )
      );
  }

  await writeAuditLog(req, {
    action: "UPDATE",
    module: "Claim",
    actionDescription: `Submitted assessment report for claim ${claimId}`,
    resourceType: "Claim",
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: {
      old: { status: "Assessment" },
      new: { status: "Assessed", assessmentReport },
    },
  });

  return claim;
};

const forgotPassword = async (email) => {
  const user = await Assessor.findOne({ email });
  // Always return the same response so the endpoint cannot be used to enumerate accounts.
  if (user) {
    const { rawToken, hashedToken, expires } = await createResetToken();
    // updateOne bypasses the password pre-save hook (which would otherwise re-hash on save).
    await Assessor.updateOne(
      { _id: user._id },
      {
        $set: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: expires,
        },
      }
    );

    await emailService.sendEmailNotification(
      user.email,
      "Your Ave Insurance password reset code",
      resetEmailBody(user.name, rawToken)
    );
  }
  return {
    message: "If an account exists for that email, a reset link has been sent.",
  };
};

const resetPassword = async (email, token, newPassword) => {
  const user = await Assessor.findOne({ email });
  if (!user || !(await verifyResetToken(token, user))) {
    throw new Error("Reset token is invalid or has expired");
  }

  assertValidPassword(newPassword);
  // Hash here and write via updateOne to avoid the model's pre-save hook double-hashing.
  const hashed = await bcrypt.hash(newPassword, 10);
  await Assessor.updateOne(
    { _id: user._id },
    {
      $set: { password: hashed },
      $unset: { resetPasswordToken: "", resetPasswordExpires: "" },
    }
  );

  return { message: "Password has been reset successfully" };
};

const submitReAssessmentReport = async (
  claimId,
  { notes, photos, outcome, assessorId },
  req
) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error("Claim not found");
  if (claim.status !== "Re-Assessment")
    throw new Error("Claim must be under Re-Assessment to submit a report");
  if (!notes || !notes.trim()) throw new Error("Notes are required");
  if (!outcome || !["Passed", "Failed"].includes(outcome))
    throw new Error("outcome must be Passed or Failed");

  const start = Date.now();
  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;

  claim.reAssessmentReport = {
    notes: notes.trim(),
    photos: Array.isArray(photos) ? photos : [],
    outcome,
    assessorId: assessorId || null,
    submittedAt: new Date(),
  };

  if (outcome === "Passed") {
    claim.status = "ReAssessed";
  } else if (claim.selfRepair && claim.selfRepair.opted) {
    // Failed self-repair — no garage involved; send it back to the customer to redo the work.
    claim.status = "UnderRepair";

    if (claim.claimant?.email) {
      await emailService.sendEmailNotification(
        claim.claimant.email,
        "Self-Repair Re-Assessment — Further Work Required",
        `Dear ${claim.claimant.name},

Following the re-assessment of your vehicle (${vehicle}), our assessor has identified outstanding issues that still need to be addressed.

Assessor notes: ${notes.trim()}

Please complete the remaining repairs and call for re-assessment again once done.

Best Regards,
Admin Team`
      );
    }
    if (claim.claimant?.phone) {
      await whatsappService.sendWhatsAppMessage(
        claim.claimant.phone,
        `Hi ${
          claim.claimant.name
        }, the re-assessment of your vehicle (${vehicle}) found outstanding issues.\n\nNotes: ${notes.trim()}\n\nPlease complete the remaining repairs and call for re-assessment again. — Ave Insurance`
      );
    }
  } else {
    // Failed garage repair — return directly to Repair and notify garage
    claim.status = "Repair";

    if (claim.awardedGarage?.garageId) {
      const garage = await Garage.findById(claim.awardedGarage.garageId);
      if (garage?.email) {
        await emailService.sendEmailNotification(
          garage.email,
          "Re-Assessment Failed — Further Repair Required",
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
          `Hi ${
            garage.name
          }, the re-assessment for vehicle (${vehicle}) has *failed*.\n\nNotes: ${notes.trim()}\n\nPlease fix the outstanding issues and resubmit for re-assessment. — Ave Insurance`
        );
      }
    }

    if (claim.claimant?.email) {
      await emailService.sendEmailNotification(
        claim.claimant.email,
        "Repair Re-Assessment — Further Work Required",
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
  await cache.delPattern("cache:claims:*");
  await cache.del(`cache:claim:${claimId}`);
  // Same gap as submitAssessmentReport: the assessor's own bids list is cached
  // per-assessor and isn't covered by the patterns above, so the app kept
  // showing the pre-report claim status (and the Complete/Reject Job actions)
  // until the TTL expired.
  const reAssessingAssessorId = assessorId || claim.awardedAssessor?.assessorId;
  if (reAssessingAssessorId) {
    await cache.del(`cache:assessor:bids:${reAssessingAssessorId}`);
  }

  await writeAuditLog(req, {
    action: "UPDATE",
    module: "Claim",
    actionDescription: `Assessor submitted re-assessment report for claim ${claimId} — outcome: ${outcome}`,
    resourceType: "Claim",
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: {
      old: { status: "Re-Assessment" },
      new: { status: claim.status, outcome },
    },
  });

  return claim;
};

const completeRepair = async (claimId, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error("Claim not found");
  if (claim.status !== "ReAssessed")
    throw new Error(
      "Re-assessment must be submitted and passed before completing"
    );
  if (claim.reAssessmentReport?.outcome !== "Passed")
    throw new Error("Re-assessment outcome is not Passed — cannot complete");

  const vehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  const start = Date.now();

  claim.status = "Completed";
  claim.repairDate = new Date();
  await claim.save();
  await cache.delPattern("cache:claims:*");
  await cache.del(`cache:claim:${claimId}`);
  if (claim.awardedAssessor?.assessorId) {
    await cache.del(`cache:assessor:bids:${claim.awardedAssessor.assessorId}`);
  }

  await writeAuditLog(req, {
    action: "UPDATE",
    module: "Claim",
    actionDescription: `Admin completed claim ${claimId} following passed re-assessment`,
    resourceType: "Claim",
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: "ReAssessed" }, new: { status: "Completed" } },
  });

  if (!claim.selfRepair?.opted && claim.awardedGarage?.garageId) {
    const garage = await Garage.findById(claim.awardedGarage.garageId);
    if (garage) {
      garage.pendingWork = Math.max(0, (garage.pendingWork || 1) - 1);
      await garage.save();
    }
  }

  if (claim.claimant?.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      "Repair Verified & Claim Closed",
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
  if (!claim) throw new Error("Claim not found");
  if (claim.status !== "Re-Assessment")
    throw new Error("Claim must be under Re-Assessment to mark it as Rejected");

  const start = Date.now();
  claim.status = "Repair";
  const rrVehicle = claim.vehiclesInvolved[0]?.licensePlate || claim._id;
  const garage = await Garage.findById(claim.awardedGarage.garageId);
  if (garage && garage.email) {
    await emailService.sendEmailNotification(
      garage.email,
      "Repair Rejected",
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
  await cache.delPattern("cache:claims:*");
  await cache.del(`cache:claim:${claimId}`);
  if (claim.awardedAssessor?.assessorId) {
    await cache.del(`cache:assessor:bids:${claim.awardedAssessor.assessorId}`);
  }

  await writeAuditLog(req, {
    action: "UPDATE",
    module: "Claim",
    actionDescription: `Rejected repair for claim ${claimId}: ${rejectionReason}`,
    resourceType: "Claim",
    resourceId: claim._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: {
      old: { status: "Re-Assessment" },
      new: { status: "Repair", rejectionReason },
    },
  });

  return claim;
};
// Assessor statistics for the admin dashboard
const getAssessorStatistics = async (company) => {
  return cache.wrap(
    `cache:stats:assessors:${company || "all"}`,
    async () => {
      const scope = company ? { company } : {};
      const totalAssessors = await Assessor.countDocuments(scope);
      const busyAssessors = await Assessor.countDocuments({
        ...scope,
        "ratings.totalRatings": { $gt: 0 },
      });
      const freeAssessors = totalAssessors - busyAssessors;
      return { totalAssessors, busyAssessors, freeAssessors };
    },
    1800
  );
};

const getTopAssessors = async (company) => {
  return cache.wrap(
    `cache:assessors:top:${company || "all"}`,
    () =>
      Assessor.aggregate([
        // Aggregations don't cast — the tenant $match needs an explicit ObjectId.
        ...(company
          ? [
              {
                $match: {
                  company: new mongoose.Types.ObjectId(String(company)),
                },
              },
            ]
          : []),
        {
          $lookup: {
            from: "claims",
            localField: "_id",
            foreignField: "awardedAssessor.assessorId",
            as: "claims",
          },
        },
        {
          $project: {
            name: 1,
            "ratings.averageRating": 1,
            totalClaimsAssessed: { $size: "$claims" },
          },
        },
        { $sort: { totalClaimsAssessed: -1 } },
        { $limit: 10 },
      ]),
    3600
  );
};

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
  forgotPassword,
  resetPassword,
  completeRepair,
  rejectRepair,
  getAssessorStatistics,
  getTopAssessors,
};
