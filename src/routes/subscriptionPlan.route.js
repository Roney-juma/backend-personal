const express = require('express');
const router = express.Router();
const controller = require('../controllers/subscriptionPlan.controller');
const verifyToken = require('../middlewheres/verifyToken');

// Public — companies can view available plans
router.get('/', controller.getAllPlans);
router.get('/:id', controller.getPlanById);

// Protected
router.post('/', verifyToken(), controller.createPlan);
router.patch('/:id', verifyToken(), controller.updatePlan);
router.patch('/:id/toggle', verifyToken(), controller.togglePlan);
router.delete('/:id', verifyToken(), controller.deletePlan);

module.exports = router;
