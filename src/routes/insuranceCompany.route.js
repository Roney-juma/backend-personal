const express = require('express');
const router = express.Router();
const controller = require('../controllers/insuranceCompany.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

// Public
router.post('/login', controller.loginCompany);
router.post('/reset-password', controller.resetCompanyPassword);

// Protected (platform staff only)
router.post('/', verifyProviderToken(), controller.createCompany);
router.get('/', verifyProviderToken(), controller.getAllCompanies);
router.get('/:id', verifyProviderToken(), controller.getCompanyById);
router.patch('/:id', verifyProviderToken(), controller.updateCompany);
router.patch('/:id/status', verifyProviderToken(), controller.updateCompanyStatus);
router.delete('/:id', verifyProviderToken(), controller.deleteCompany);
router.get('/:id/stats', verifyProviderToken(), controller.getCompanyStats);

module.exports = router;
