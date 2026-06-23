const express = require('express');
const router = express.Router();
const controller = require('../controllers/investigator.controller');
const verifyToken = require('../middlewheres/verifyToken');

// Auth — no token required
router.post('/login', controller.login);
router.post('/reset-password', controller.resetPassword);

// Investigator management (admin only)
router.post('/create', verifyToken(), controller.createInvestigator);
router.get('/stats', verifyToken(), controller.getStats);
router.get('/', verifyToken(), controller.getAllInvestigators);
router.get('/:id', verifyToken(), controller.getInvestigator);
router.put('/:id', verifyToken(), controller.updateInvestigator);
router.delete('/:id', verifyToken(), controller.deleteInvestigator);
router.patch('/:id/fcm-token', verifyToken(), controller.updateFcmToken);

// Investigation workflow
// Insurance company assigns investigator to a claim (after assessment report submitted)
router.post('/assign/:claimId', verifyToken(), controller.assignInvestigator);

// Investigator acknowledges and starts investigation
router.patch('/investigations/:investigationId/start', verifyToken(), controller.startInvestigation);

// Investigator submits investigation report
router.post('/investigations/:investigationId/submit-report', verifyToken(), controller.submitReport);

// Admin/insurance reviews submitted report
router.put('/investigations/:investigationId/review', verifyToken(), controller.reviewReport);

// Read endpoints
router.get('/my-investigations/:investigatorId', verifyToken(), controller.getMyInvestigations);
router.get('/investigations/all', verifyToken(), controller.getAllInvestigations);
router.get('/investigations/:investigationId', verifyToken(), controller.getInvestigation);

module.exports = router;
