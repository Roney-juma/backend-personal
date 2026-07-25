const express = require('express');
const router = express.Router();
const controller = require('../controllers/insuranceCompany.controller');

// Public — mobile app company picker. No auth by design; exposes only
// _id/companyName/logo of active companies.
router.get('/', controller.listPublicCompanies);

module.exports = router;
