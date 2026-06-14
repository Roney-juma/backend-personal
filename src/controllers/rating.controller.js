const ratingService = require('../service/rating.service');

const ALLOWED_REVIEWER_TYPES = {
  garage: ['Customer', 'Assessor'],
  supplier: ['Garage'],
};

const submitRating = async (req, res) => {
  const { entityId, entityType } = req.params;
  const { rating, feedback, claimId, reviewerType } = req.body;
  const reviewerId = req.user._id;

  const allowed = ALLOWED_REVIEWER_TYPES[entityType];
  if (!allowed) {
    return res.status(400).json({ message: `Invalid entity type: ${entityType}` });
  }
  if (!reviewerType || !allowed.includes(reviewerType)) {
    return res.status(400).json({ message: `reviewerType must be one of: ${allowed.join(', ')} for a ${entityType}` });
  }
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'rating must be a number between 1 and 5' });
  }
  if (!claimId) {
    return res.status(400).json({ message: 'claimId is required' });
  }

  try {
    const updatedRatings = await ratingService.addRatingAndFeedback(
      entityId, entityType, reviewerId, reviewerType, claimId, rating, feedback
    );
    res.status(200).json(updatedRatings);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ message: error.message });
    }
    if (error.message.toLowerCase().includes('not authorized') || error.message.includes('already rated')) {
      return res.status(403).json({ message: error.message });
    }
    res.status(500).json({ message: error.message });
  }
};

const getRatings = async (req, res) => {
  const { entityId, entityType } = req.params;

  try {
    const ratings = await ratingService.getRatings(entityId, entityType);
    res.status(200).json(ratings);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ message: error.message });
    }
    res.status(400).json({ message: error.message });
  }
};

module.exports = { submitRating, getRatings };
