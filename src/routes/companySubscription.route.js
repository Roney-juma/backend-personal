const express = require('express');
const router = express.Router();
const controller = require('../controllers/companySubscription.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.post('/', verifyProviderToken(), controller.createSubscription);
router.get('/', verifyProviderToken(), controller.getAllSubscriptions);
router.get('/company/:companyId', verifyProviderToken(), controller.getSubscriptionsByCompany);
router.get('/:id', verifyProviderToken(), controller.getSubscriptionById);
router.patch('/:id', verifyProviderToken(), controller.updateSubscription);
router.patch('/:id/cancel', verifyProviderToken(), controller.cancelSubscription);
router.patch('/:id/renew', verifyProviderToken(), controller.renewSubscription);
router.post('/:id/invoice', verifyProviderToken(), controller.invoiceSubscription);

module.exports = router;
