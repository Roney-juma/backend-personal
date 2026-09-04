const express = require('express');
const policyTypeController = require('../controllers/policyType.controller');
const verifyToken = require('../middlewheres/verifyToken');
const optionalToken = require('../middlewheres/optionalToken');
const requirePermission = require('../middlewheres/requirePermission');

const router = express.Router();

// Reads are public — policy types are reference data (e.g. for populating claim forms).
// optionalToken lets authenticated callers (mobile app, insurer portal) get a
// tenant-scoped list (global + their company) while anonymous callers see everything.
router.get('/', optionalToken(), policyTypeController.getAllPolicyTypes);
router.get('/:id', policyTypeController.getPolicyTypeById);

// Mutations remain authenticated (admin).
router.post('/', verifyToken(), requirePermission('CREATE_POLICY_TYPE'), policyTypeController.createPolicyType);
router.patch('/:id', verifyToken(), requirePermission('UPDATE_POLICY_TYPE'), policyTypeController.updatePolicyType);
router.delete('/:id', verifyToken(), requirePermission('DELETE_POLICY_TYPE'), policyTypeController.deletePolicyType);

module.exports = router;
