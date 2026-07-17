const express = require('express');
const router = express.Router();
const controller = require('../controllers/insuranceCompany.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');
const authLimiter = require('../middlewheres/authLimiter');

// Public
router.post('/login', authLimiter, controller.loginCompany);
router.post('/reset-password', authLimiter, controller.resetCompanyPassword);

// Protected (platform staff only)
router.post('/', verifyProviderToken(), controller.createCompany);
router.get('/', verifyProviderToken(), controller.getAllCompanies);
router.get('/company-users/:id', verifyProviderToken(), controller.getCompanyUsers);
router.get('/:id/garages', verifyProviderToken(), controller.getCompanyGarages);
router.get('/:id/assessors', verifyProviderToken(), controller.getCompanyAssessors);
router.get('/:id/suppliers', verifyProviderToken(), controller.getCompanySuppliers);
router.get('/:id', verifyProviderToken(), controller.getCompanyById);
router.patch('/:id', verifyProviderToken(), controller.updateCompany);
router.patch('/:id/status', verifyProviderToken(), controller.updateCompanyStatus);
router.delete('/:id', verifyProviderToken(), controller.deleteCompany);
router.get('/:id/stats', verifyProviderToken(), controller.getCompanyStats);

module.exports = router;
