const ApiError = require('../utils/ApiError.js');
const bcrypt = require('bcrypt');
const Supplier = require('../models/supplier.model');
const SupplyBid = require('../models/supplyBids.model');
const Claim = require('../models/claim.model');
const cache = require('../cache');

const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await getUserByEmail(email);
  if (!user) {
      return false
      }

  const authorized = await user.isPasswordMatch(password);
  if (!authorized) {
      return false
  }

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
  const newSupplier = new Supplier(supplierData);
  const password = await bcrypt.hash(newSupplier.password, 10);
  newSupplier.password = password;

//   Send Email notification



  const saved = await newSupplier.save();
  await cache.del('cache:suppliers:all');
  return saved;
};

const getAllSuppliers = async () => {
  return cache.wrap('cache:suppliers:all', () => Supplier.find(), 1800);
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

  return supplyBid;
};


const getClaimsInGarage = async () => {
  return cache.wrap('cache:claims:in-garage', () =>
    Claim.find({
      status: { $in: ['Assessed', 'GlassApproved'] },
      supplierBids: { $not: { $elemMatch: { status: 'Accepted' } } },
    }),
  300);
};

const repairPartsDelivered = async (claimId) => {
    const claim = await Claim.findById(claimId);
    if (!claim) {
        throw new Error('Claim not found');
    }

    const acceptedBidId = claim.supplierBids.find(async (bidId) => {
        const bid = await SupplyBid.findById(bidId);
        return bid && bid.status === 'Accepted';
    });

    if (!acceptedBidId) {
        throw new Error('No accepted supplier bid found');
    }

    const acceptedBid = await SupplyBid.findById(acceptedBidId);
    acceptedBid.status = 'Delivered';
    claim.assessmentReport.parts = bid.parts
    await acceptedBid.save();

    claim.status = 'Garage';
    claim.repairDate = new Date();
    await claim.save();
    await cache.del('cache:claims:in-garage');
    await cache.delPattern('cache:claims:*');

    return claim;
};

const resetPassword = async (email, newPassword) => {
  const user = await getUserByEmail(email);
  if (!user) {
      throw new Error('Invalid request');
  }

  // const isTokenValid = await bcrypt.compare(token, user.resetPasswordToken);
  // if (!isTokenValid || user.resetPasswordExpires < Date.now()) {
  //     throw new Error('Token is invalid or expired');
  // }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  user.password = hashedPassword;

  // Clear reset token and expiration
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
    resetPassword

};