const express = require('express');
const router = express.Router();
const controller = require('../controllers/subscriptionPlan.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

// Public — companies can view available plans
router.get('/', controller.getAllPlans);
router.get('/:id', controller.getPlanById);

// Protected
router.post('/', verifyProviderToken(), controller.createPlan);
router.patch('/:id', verifyProviderToken(), controller.updatePlan);
router.patch('/:id/toggle', verifyProviderToken(), controller.togglePlan);
router.delete('/:id', verifyProviderToken(), controller.deletePlan);

module.exports = router;
