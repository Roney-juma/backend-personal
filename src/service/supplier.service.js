const ApiError = require("../utils/ApiError.js");
const bcrypt = require("bcrypt");
const Supplier = require("../models/supplier.model.js");
const SupplyBid = require("../models/supplyBids.model.js");
const Claim = require("../models/claim.model.js");
const cache = require("../cache/index.js");
const { resolveLocation } = require("../utils/geocode");
const notificationService = require("./notification.service.js");
const emailService = require("./email.service.js");
const {
  createResetToken,
  verifyResetToken,
  resetEmailBody,
} = require("../utils/passwordReset.js");
const {
  isLocked,
  registerFailedAttempt,
  resetAttempts,
  AccountLockedError,
} = require("../utils/accountLockout.js");
const { assertValidPassword } = require("../utils/passwordPolicy.js");
const { DEFAULT_TEMP_PASSWORD } = require("../constants/userDefaults.js");

const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await getUserByEmail(email);
  if (!user) {
    return false;
  }

  if (isLocked(user)) {
    throw new AccountLockedError(user);
  }

  const authorized = await user.isPasswordMatch(password);
  if (!authorized) {
    await registerFailedAttempt(user);
    return false;
  }

  await resetAttempts(user);
  return user;
};

const getUserByEmail = async (email) => {
  try {
    // Use findOne to retrieve a single user document
    const user = await Supplier.findOne({ email: email });
    return user;
  } catch (error) {
    require("../middlewheres/logger.js").error(
      "Error fetching user by email: %s",
      error.message
    );
    throw error;
  }
};

const createSupplier = async (supplierData) => {
  const existingSupplier = await Supplier.findOne({
    email: supplierData.email,
  });
  if (existingSupplier) {
    throw new ApiError("Email is already registered");
  }

  // Admin-created: default temporary password + forced change on first login.
  const plainPassword = supplierData.password || DEFAULT_TEMP_PASSWORD;
  const newSupplier = new Supplier(supplierData);
  newSupplier.password = await bcrypt.hash(plainPassword, 10);
  newSupplier.mustChangePassword = true;

  const saved = await newSupplier.save();
  await cache.del("cache:suppliers:all");

  if (saved.email) {
    await emailService
      .sendEmailNotification(
        saved.email,
        "Welcome to Ave Insurance - Your Account Details",
        `Dear ${saved.name},\n\nYour supplier account has been created.\n\nEmail: ${saved.email}\nTemporary password: ${plainPassword}\n\nFor your security, you will be asked to set a new password the first time you log in.\n\nBest Regards,\nAdmin Team`
      )
      .catch(() => {
        /* non-fatal */
      });
  }

  return saved;
};

const getAllSuppliers = async ({
  page = 1,
  limit = 10,
  search = "",
  insuranceCompany,
} = {}) => {
  const query = {};
  if (insuranceCompany) query.insuranceCompany = insuranceCompany;
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const p = Math.max(Number(page) || 1, 1);
  const l = Math.min(Math.max(Number(limit) || 10, 1), 100); // cap page size
  const skip = (p - 1) * l;

  const [suppliers, total] = await Promise.all([
    Supplier.find(query).skip(skip).limit(l).sort({ createdAt: -1 }).lean(),
    Supplier.countDocuments(query),
  ]);

  return { suppliers, total, page: p, limit: l, pages: Math.ceil(total / l) };
};

const getSupplierById = async (supplierId) => {
  return cache.wrap(
    `cache:supplier:${supplierId}`,
    () => Supplier.findById(supplierId),
    1800
  );
};

const updateSupplier = async (supplierId, supplierData, insuranceCompany) => {
  // Scope to the requester's company (staff → no scope). Strip insuranceCompany from
  // the payload so a company user can't reassign a supplier to another tenant.
  const filter = {
    _id: supplierId,
    ...(insuranceCompany ? { insuranceCompany } : {}),
  };
  if (insuranceCompany) delete supplierData.insuranceCompany;

  // Same treatment as garages and assessors: an address edit must carry its
  // coordinates with it. Best-effort — never fails the update.
  if (supplierData.location) {
    const existing = await Supplier.findOne(filter).select("location").lean();
    const location = await resolveLocation(existing?.location, supplierData.location);
    if (location) supplierData.location = location;
  }

  const result = await Supplier.findOneAndUpdate(filter, supplierData, {
    new: true,
  });
  await cache.del("cache:suppliers:all", `cache:supplier:${supplierId}`);
  return result;
};

const deleteSupplier = async (supplierId, insuranceCompany) => {
  const filter = {
    _id: supplierId,
    ...(insuranceCompany ? { insuranceCompany } : {}),
  };

  // Integrity guard: refuse to delete a supplier engaged on a live claim —
  // either via an accepted parts bid or an assigned glass repair.
  const acceptedBids = await SupplyBid.find({ supplierId, status: "Accepted" })
    .select("claimId")
    .lean();
  const claimIds = acceptedBids.map((b) => b.claimId).filter(Boolean);
  const activeParts = claimIds.length
    ? await Claim.countDocuments({
        _id: { $in: claimIds },
        status: { $nin: ["Completed", "Rejected"] },
      })
    : 0;
  const activeGlass = await Claim.countDocuments({
    "glassRepair.supplierId": supplierId,
    status: { $nin: ["Completed", "Rejected"] },
  });
  const activeClaims = activeParts + activeGlass;
  if (activeClaims > 0) {
    throw new ApiError(
      409,
      `Cannot delete this supplier: they are engaged on ${activeClaims} active claim(s). Complete or reassign those first.`
    );
  }

  const result = await Supplier.softDeleteOne(filter);
  await cache.del("cache:suppliers:all", `cache:supplier:${supplierId}`);
  return result;
};

const getSupplierBids = async (supplierId) => {
  return cache.wrap(
    `cache:supplier:bids:${supplierId}`,
    () =>
      SupplyBid.find({ supplierId }).populate("claimId").populate("supplierId"),
    600
  );
};

const submitBidForSupply = async (claimId, supplierId, parts) => {
  const claim = await Claim.findById(claimId);
  if (!claim) {
    return { error: "Claim not found" };
  }
  if (claim.status !== "Assessed" && claim.status !== "GlassApproved") {
    return {
      error: "Bids can only be submitted for assessed or glass-approved claims",
    };
  }
  const existingBid = await SupplyBid.findOne({ claimId, supplierId });
  if (existingBid) {
    return { error: "You have already submitted a bid for this claim" };
  }

  // Cross-tenant guard: a supplier may not bid on another insurer's claim.
  // Legacy actors/claims without a company are exempt.
  if (claim.company) {
    const bidder = await Supplier.findById(supplierId)
      .select("insuranceCompany")
      .lean();
    if (
      bidder?.insuranceCompany &&
      String(claim.company) !== String(bidder.insuranceCompany)
    ) {
      return {
        error:
          "You cannot bid on a claim belonging to another insurance company",
      };
    }
  }

  const isGlass = claim.status === "GlassApproved";
  const normalizedParts = isGlass
    ? parts.map((p) => ({
        partName: "Wind Screen",
        cost: p.cost || 0,
      }))
    : parts.map((p) => ({
        partName: p.partName || p.name || "",
        cost: p.cost || 0,
      }));

  const totalCost = normalizedParts.reduce((acc, part) => acc + part.cost, 0);

  const supplyBid = new SupplyBid({
    claimId,
    supplierId,
    parts: normalizedParts,
    totalCost,
    status: "Pending",
  });

  // Save the bid and associate it with the claim
  await supplyBid.save();
  claim.supplierBids.push(supplyBid);
  await claim.save();
  await cache.del(
    `cache:supplier:bids:${supplierId}`,
    "cache:claims:in-garage",
    // The single-claim key is `cache:claim:<id>` (singular) — `cache:claims:*`
    // below does NOT match it. Without this the claim detail page served a
    // pre-bid copy for up to 15 minutes and showed 0 supplier bids.
    `cache:claim:${claimId}`
  );
  await cache.delPattern("cache:claims:*");

  // Push the new bid to the supplier's other open sessions in real time.
  notificationService.emitToUser(String(supplierId), "bids:updated", {
    claimId: String(claimId),
  });

  return supplyBid;
};

// Tenant scope: suppliers attached to an insurer only see that insurer's claims;
// legacy suppliers without one (or an unresolvable requester) keep the global feed.
// Cache key varies by tenant so companies never share entries.
const getClaimsInGarage = async (supplierId) => {
  const supplier = supplierId
    ? await Supplier.findById(supplierId).select("insuranceCompany").lean()
    : null;
  const company = supplier?.insuranceCompany;
  return cache.wrap(
    `cache:claims:in-garage:${company || "all"}`,
    () =>
      Claim.find({
        status: { $in: ["Assessed", "GlassApproved"] },
        supplierBids: { $not: { $elemMatch: { status: "Accepted" } } },
        ...(company ? { company } : {}),
      }).lean(),
    300
  );
};

// The awarded supplier confirms delivery of the parts. This is a deliberate,
// supplier-initiated action (nothing marks delivery automatically) — purely a
// physical-delivery/claim-workflow step. Invoicing is a separate, independent
// action (see vendorInvoice.service.js): the supplier requests an invoice for
// this car once it shows up eligible, whenever they're ready to bill for it.
const repairPartsDelivered = async (claimId, supplierId, { notes } = {}) => {
  const claim = await Claim.findById(claimId);
  if (!claim) {
    throw new ApiError(404, "Claim not found");
  }

  // Single indexed query instead of a findById per bid. The previous
  // `supplierBids.find(async …)` always matched the first bid (an async predicate
  // returns a Promise, which is always truthy) — this fixes that bug too.
  // Scoped to the caller: only the supplier whose bid was accepted may confirm.
  const acceptedBid = await SupplyBid.findOne({
    _id: { $in: claim.supplierBids },
    supplierId,
    status: { $in: ["Accepted", "Delivered"] },
  });

  if (!acceptedBid) {
    throw new ApiError(403, "You have no awarded bid on this claim");
  }
  if (acceptedBid.status === "Delivered") {
    throw new ApiError(409, "Parts for this claim are already marked as delivered");
  }
  // 'Awarded' is the normal awaiting-delivery state; 'Garage' covers claims
  // awarded before this flow existed (they skipped straight to Garage).
  if (!["Awarded", "Garage"].includes(claim.status)) {
    throw new ApiError(409, `Delivery cannot be confirmed while the claim is in '${claim.status}'`);
  }

  acceptedBid.status = "Delivered";
  acceptedBid.deliveredAt = new Date();
  if (notes) acceptedBid.deliveryNotes = notes;
  claim.assessmentReport.parts = acceptedBid.parts;
  await acceptedBid.save();

  claim.status = "Garage";
  claim.repairDate = new Date();
  await claim.save();
  // Same singular/plural trap as placeBid: without `cache:claim:<id>` the claim
  // stays cached as 'Awarded', which the portal renders as "Awaiting Delivery"
  // long after the parts were delivered.
  await cache.del(
    "cache:claims:in-garage",
    `cache:supplier:bids:${supplierId}`,
    `cache:claim:${claimId}`
  );
  await cache.delPattern("cache:claims:*");

  // Refresh the supplier's own bid list in any open sessions.
  notificationService.emitToUser(String(supplierId), "bids:updated", {
    claimId: String(claimId),
  });

  return claim;
};

const forgotPassword = async (email) => {
  const user = await getUserByEmail(email);
  // Always return the same response so the endpoint cannot be used to enumerate accounts.
  if (user) {
    const { rawToken, hashedToken, expires } = await createResetToken();
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = expires;
    await user.save();

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
  const user = await getUserByEmail(email);
  if (!user || !(await verifyResetToken(token, user))) {
    throw new Error("Reset token is invalid or has expired");
  }

  assertValidPassword(newPassword);
  user.password = await bcrypt.hash(newPassword, 10);

  // Invalidate the token so it can only be used once.
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  await user.save();

  return { message: "Password has been reset successfully" };
};

module.exports = {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
  getSupplierBids,
  submitBidForSupply,
  getClaimsInGarage,
  repairPartsDelivered,
  loginUserWithEmailAndPassword,
  forgotPassword,
  resetPassword,
};
