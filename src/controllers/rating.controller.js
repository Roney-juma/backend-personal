const ratingService = require('../service/rating.service');

const submitRating = async (req, res) => {
  const { entityId, entityType } = req.params; 
  const { userId, rating, feedback } = req.body;
  console.log(entityId, entityType, userId, rating, feedback)

  try {
    const updatedEntity = await ratingService.addRatingAndFeedback(entityId, entityType, userId, rating, feedback);
    res.status(200).json(updatedEntity);
  } catch (error) {
    console.error('Error submitting rating:', error);
    res.status(500).json({ error: error.message });
  }
};

const getRatings = async (req, res) => {
    const { entityId, entityType } = req.params;
  
    try {
      // Call the service to get ratings
      const ratings = await ratingService.getRatings(entityId, entityType);
      
      res.status(200).json(ratings);
    } catch (error) {
      console.error('Error fetching ratings:', error.message);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ message: error.message });
      }
  
      res.status(400).json({ message: error.message });
    }
  };
  

module.exports = {
  submitRating,
  getRatings
};
