const express = require('express');
const router = express.Router();
const controller = require('../controllers/demoRequest.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

// Public — called from the landing page "Request a Demo" form (no auth)
router.post('/', controller.createDemoRequest);

// Provider-only — view and manage incoming demo requests
router.get('/',     verifyProviderToken(), controller.getAllDemoRequests);
router.get('/:id',  verifyProviderToken(), controller.getDemoRequestById);
router.patch('/:id', verifyProviderToken(), controller.updateDemoRequest);

module.exports = router;
