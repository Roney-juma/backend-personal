const express = require('express');
const router = express.Router();
const controller = require('../controllers/insuranceCompany.controller');
const verifyToken = require('../middlewheres/verifyToken');

// Public
router.post('/login', controller.loginCompany);
router.post('/reset-password', controller.resetCompanyPassword);

// Protected (platform admin only)
router.post('/', verifyToken(), controller.createCompany);
router.get('/', verifyToken(), controller.getAllCompanies);
router.get('/:id', verifyToken(), controller.getCompanyById);
router.patch('/:id', verifyToken(), controller.updateCompany);
router.patch('/:id/status', verifyToken(), controller.updateCompanyStatus);
router.delete('/:id', verifyToken(), controller.deleteCompany);
router.get('/:id/stats', verifyToken(), controller.getCompanyStats);

module.exports = router;
