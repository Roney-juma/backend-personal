const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');
const Claim = require('../models/claim.model');
const SupplyBid = require('../models/supplyBids.model');

const ENTITY_MAP = {
  garage: Garage,
  supplier: Supplier,
  assessor: Assessor,
};

async function authorizeRating(entityType, entityId, reviewerId, reviewerType, claimId) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new Error('Claim not found');

  if (entityType === 'garage') {
    if (reviewerType === 'Customer') {
      // Customer rates garage only after car has been collected (status Completed)
      const isOwner = claim.customerId?.toString() === reviewerId.toString();
      const isAwardedGarage = claim.awardedGarage?.garageId?.toString() === entityId.toString();
      const isCompleted = claim.status === 'Completed';
      if (!isOwner || !isAwardedGarage || !isCompleted) {
        throw new Error('Not authorized: claim must be Completed and linked to this garage and customer');
      }
    } else if (reviewerType === 'Assessor') {
      // Assessor rates garage only after reassessment
      const isAwardedAssessor = claim.awardedAssessor?.assessorId?.toString() === reviewerId.toString();
      const isAwardedGarage = claim.awardedGarage?.garageId?.toString() === entityId.toString();
      const isReassessment = claim.status === 'Completed';
      if (!isAwardedAssessor || !isAwardedGarage || !isReassessment) {
        throw new Error('Not authorized: claim must be in Completed and linked to this assessor and garage');
      }
    }
  } else if (entityType === 'supplier') {
    // Garage rates supplier only after parts have been delivered
    const isAwardedGarage = claim.awardedGarage?.garageId?.toString() === reviewerId.toString();
    if (!isAwardedGarage) {
      throw new Error('Not authorized: you are not the awarded garage for this claim');
    }
    const supplier = await Supplier.findOne({
      claimId,
      supplierId: entityId,
      status: 'Delivered',
    });
    if (!supplier) {
      throw new Error('Not authorized: no delivered supply bid found for this supplier and claim');
    }
  }
}

const addRatingAndFeedback = async (entityId, entityType, reviewerId, reviewerType, claimId, rating, feedback) => {
  const Model = ENTITY_MAP[entityType];
  if (!Model) throw new Error('Invalid entity type');

  const entity = await Model.findById(entityId);
  if (!entity) throw new Error(`${entityType} not found`);

  await authorizeRating(entityType, entityId, reviewerId, reviewerType, claimId);

  const alreadyRated = entity.ratings.reviews.some(
    r => r.reviewerId?.toString() === reviewerId.toString() && r.claimId?.toString() === claimId.toString()
  );
  if (alreadyRated) {
    throw new Error('You have already rated this entity for this claim');
  }

  entity.ratings.reviews.push({ reviewerId, reviewerType, claimId, rating, feedback });
  entity.ratings.totalRatings = entity.ratings.reviews.length;

  const totalSum = entity.ratings.reviews.reduce((acc, r) => acc + r.rating, 0);
  entity.ratings.averageRating = parseFloat((totalSum / entity.ratings.totalRatings).toFixed(2));

  await entity.save();
  return entity.ratings;
};

const getRatings = async (entityId, entityType) => {
  const Model = ENTITY_MAP[entityType];
  if (!Model) throw new Error('Invalid entity type');

  const entity = await Model.findById(entityId);
  if (!entity) throw new Error(`${entityType} not found`);

  return entity.ratings;
};

module.exports = { addRatingAndFeedback, getRatings };
