const ApiError = require('../utils/ApiError.js');
const bcrypt = require('bcrypt');
const Supplier = require('../models/supplier.model');
const SupplyBid = require('../models/supplyBids.model');
const Claim = require('../models/claim.model');
const cache = require('../cache');
const notificationService = require('./notification.service');
const emailService = require('./email.service');
const { createResetToken, verifyResetToken, resetEmailBody } = require('../utils/passwordReset');
const { isLocked, registerFailedAttempt, resetAttempts, AccountLockedError } = require('../utils/accountLockout');
const { assertValidPassword } = require('../utils/passwordPolicy');
const { DEFAULT_TEMP_PASSWORD } = require('../constants/userDefaults');

const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await getUserByEmail(email);
  if (!user) {
      return false
      }

  if (isLocked(user)) {
      throw new AccountLockedError(user);
  }

  const authorized = await user.isPasswordMatch(password);
  if (!authorized) {
      await registerFailedAttempt(user);
      return false
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
    require('../middlewheres/logger').error('Error fetching user by email: %s', error.message);
    throw error;
  }
};

const createSupplier = async (supplierData) => {
  const existingSupplier = await Supplier.findOne({ email: supplierData.email });
  if (existingSupplier) {
      throw new ApiError('Email is already registered');
  }

  // Admin-created: default temporary password + forced change on first login.
  const plainPassword = supplierData.password || DEFAULT_TEMP_PASSWORD;
  const newSupplier = new Supplier(supplierData);
  newSupplier.password = await bcrypt.hash(plainPassword, 10);
  newSupplier.mustChangePassword = true;

  const saved = await newSupplier.save();
  await cache.del('cache:suppliers:all');

  if (saved.email) {
    await emailService.sendEmailNotification(
      saved.email,
      'Welcome to Ave Insurance - Your Account Details',
      `Dear ${saved.name},\n\nYour supplier account has been created.\n\nEmail: ${saved.email}\nTemporary password: ${plainPassword}\n\nFor your security, you will be asked to set a new password the first time you log in.\n\nBest Regards,\nAdmin Team`
    ).catch(() => { /* non-fatal */ });
  }

  return saved;
};

const getAllSuppliers = async ({ page = 1, limit = 10, search = '' } = {}) => {
  const query = {};
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
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
  return cache.wrap(`cache:supplier:${supplierId}`, () => Supplier.findById(supplierId), 1800);
};

const updateSupplier = async (supplierId, supplierData) => {
  const result = await Supplier.findByIdAndUpdate(supplierId, supplierData, { new: true });
  await cache.del('cache:suppliers:all', `cache:supplier:${supplierId}`);
  return result;
};

const deleteSupplier = async (supplierId) => {
  const result = await Supplier.findByIdAndDelete(supplierId);
  await cache.del('cache:suppliers:all', `cache:supplier:${supplierId}`);
  return result;
};

const getSupplierBids = async (supplierId) => {
  return cache.wrap(`cache:supplier:bids:${supplierId}`, () =>
    SupplyBid.find({ supplierId }).populate('claimId').populate('supplierId'),
  600);
};

const submitBidForSupply = async (claimId, supplierId, parts) => {
  const claim = await Claim.findById(claimId);
  if (!claim) {
      return { error: 'Claim not found' };
  }
  if (claim.status !== 'Assessed' && claim.status !== 'GlassApproved') {
      return { error: 'Bids can only be submitted for assessed or glass-approved claims' };
  }
  const existingBid = await SupplyBid.findOne({ claimId, supplierId });
  if (existingBid) {
      return { error: 'You have already submitted a bid for this claim' };
  }

  const isGlass = claim.status === 'GlassApproved';
  const normalizedParts = isGlass
    ? parts.map(p => ({
        partName: 'Wind Screen',
        cost: p.cost || 0,
      }))
    : parts.map(p => ({
        partName: p.partName || p.name || '',
        cost: p.cost || 0,
      }));

  const totalCost = normalizedParts.reduce((acc, part) => acc + part.cost, 0);

  const supplyBid = new SupplyBid({
      claimId,
      supplierId,
      parts: normalizedParts,
      totalCost,
      status: 'Pending',
  });

  // Save the bid and associate it with the claim
  await supplyBid.save();
  claim.supplierBids.push(supplyBid);
  await claim.save();
  await cache.del(`cache:supplier:bids:${supplierId}`, 'cache:claims:in-garage');
  await cache.delPattern('cache:claims:*');

  // Push the new bid to the supplier's other open sessions in real time.
  notificationService.emitToUser(String(supplierId), 'bids:updated', { claimId: String(claimId) });

  return supplyBid;
};


const getClaimsInGarage = async () => {
  return cache.wrap('cache:claims:in-garage', () =>
    Claim.find({
      status: { $in: ['Assessed', 'GlassApproved'] },
      supplierBids: { $not: { $elemMatch: { status: 'Accepted' } } },
    }).lean(),
  300);
};

const repairPartsDelivered = async (claimId) => {
    const claim = await Claim.findById(claimId);
    if (!claim) {
        throw new Error('Claim not found');
    }

    // Single indexed query instead of a findById per bid. The previous
    // `supplierBids.find(async …)` always matched the first bid (an async predicate
    // returns a Promise, which is always truthy) — this fixes that bug too.
    const acceptedBid = await SupplyBid.findOne({
        _id: { $in: claim.supplierBids },
        status: 'Accepted',
    });

    if (!acceptedBid) {
        throw new Error('No accepted supplier bid found');
    }

    acceptedBid.status = 'Delivered';
    claim.assessmentReport.parts = acceptedBid.parts;
    await acceptedBid.save();

    claim.status = 'Garage';
    claim.repairDate = new Date();
    await claim.save();
    await cache.del('cache:claims:in-garage');
    await cache.delPattern('cache:claims:*');

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
      'Your Ave Insurance password reset code',
      resetEmailBody(user.name, rawToken)
    );
  }
  return { message: 'If an account exists for that email, a reset link has been sent.' };
};

const resetPassword = async (email, token, newPassword) => {
  const user = await getUserByEmail(email);
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
    resetPassword

};