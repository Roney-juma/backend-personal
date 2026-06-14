const express = require('express');
const ratingController = require('../controllers/rating.controller');
const verifyToken = require('../middlewheres/verifyToken');
const router = express.Router();

router.post('/:entityType/:entityId', verifyToken(), ratingController.submitRating);
router.get('/:entityType/:entityId', verifyToken(), ratingController.getRatings);

module.exports = router;
