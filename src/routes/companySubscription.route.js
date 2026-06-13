const express = require('express');
const router = express.Router();
const controller = require('../controllers/companySubscription.controller');
const verifyToken = require('../middlewheres/verifyToken');

router.post('/', verifyToken(), controller.createSubscription);
router.get('/', verifyToken(), controller.getAllSubscriptions);
router.get('/company/:companyId', verifyToken(), controller.getSubscriptionsByCompany);
router.get('/:id', verifyToken(), controller.getSubscriptionById);
router.patch('/:id', verifyToken(), controller.updateSubscription);
router.patch('/:id/cancel', verifyToken(), controller.cancelSubscription);
router.patch('/:id/renew', verifyToken(), controller.renewSubscription);

module.exports = router;
