const express = require('express');
const router = express.Router();
const controller = require('../controllers/apiKey.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.post('/', verifyProviderToken(), controller.generateApiKey);
router.get('/', verifyProviderToken(), controller.getAllApiKeys);
router.get('/company/:companyId', verifyProviderToken(), controller.getApiKeysByCompany);
router.get('/:id', verifyProviderToken(), controller.getApiKeyById);
router.patch('/:id/revoke', verifyProviderToken(), controller.revokeApiKey);
router.delete('/:id', verifyProviderToken(), controller.deleteApiKey);

module.exports = router;
