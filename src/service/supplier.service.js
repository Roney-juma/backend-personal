const ApiError = require('../utils/ApiError.js');
const bcrypt = require('bcrypt');
const Supplier = require('../models/supplier.model');
const SupplyBid = require('../models/supplyBids.model');
const Claim = require('../models/claim.model');

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
    console.error("Error fetching user by email:", error);
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



  return newSupplier.save();
};

const getAllSuppliers = async () => {
    return Supplier.find();
};

const getSupplierById = async (supplierId) => {
    return Supplier.findById(supplierId);
};

const updateSupplier = async (supplierId, supplierData) => {
    return Supplier.findByIdAndUpdate(supplierId, supplierData, { new: true });
};

const deleteSupplier = async (supplierId) => {
    return Supplier.findByIdAndDelete(supplierId);
};

const getSupplierBids = async (supplierId) => {
    return SupplyBid.find({ supplierId })
        .populate('claimId')
        .populate('supplierId');
};

const submitBidForSupply = async (claimId, supplierId, parts) => {
  const claim = await Claim.findById(claimId);
  const existingBid = await SupplyBid.findOne({ claimId, supplierId });
  if (existingBid) {
      return { error: 'You have already submitted a bid for this claim' };
  }

  const totalCost = parts.reduce((acc, part) => acc + part.cost, 0);

  const supplyBid = new SupplyBid({
      claimId,
      supplierId,
      parts,
      totalCost,
      status: 'Pending',
  });

  // Save the bid and associate it with the claim
  await supplyBid.save();
  claim.supplierBids.push(supplyBid);
  await claim.save();

  return supplyBid;
};


const getClaimsInGarage = async () => {
    return Claim.find({
        status: 'Assessed',
        'supplierBids': {
            $not: { $elemMatch: { status: 'Accepted' } }
        }
    });
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