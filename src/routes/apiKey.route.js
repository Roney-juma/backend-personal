const express = require('express');
const router = express.Router();
const controller = require('../controllers/apiKey.controller');
const verifyToken = require('../middlewheres/verifyToken');

router.post('/', verifyToken(), controller.generateApiKey);
router.get('/', verifyToken(), controller.getAllApiKeys);
router.get('/company/:companyId', verifyToken(), controller.getApiKeysByCompany);
router.get('/:id', verifyToken(), controller.getApiKeyById);
router.patch('/:id/revoke', verifyToken(), controller.revokeApiKey);
router.delete('/:id', verifyToken(), controller.deleteApiKey);

module.exports = router;
