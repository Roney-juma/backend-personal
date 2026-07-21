const express = require('express');
const claimTypeController = require('../controllers/claimType.controller');
const verifyToken = require('../middlewheres/verifyToken');
const optionalToken = require('../middlewheres/optionalToken');

const router = express.Router();

// Reads are public — claim types are reference data (e.g. for populating claim forms).
// optionalToken lets authenticated callers (mobile app, insurer portal) get a
// tenant-scoped list (global + their company) while anonymous callers see everything.
router.get('/', optionalToken(), claimTypeController.getAllClaimTypes);
router.get('/:id', claimTypeController.getClaimTypeById);

// Mutations remain authenticated (admin).
router.post('/', verifyToken(), claimTypeController.createClaimType);
router.patch('/:id', verifyToken(), claimTypeController.updateClaimType);
router.delete('/:id', verifyToken(), claimTypeController.deleteClaimType);

module.exports = router;
