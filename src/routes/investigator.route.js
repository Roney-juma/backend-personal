const express = require('express');
const router = express.Router();
const controller = require('../controllers/investigator.controller');
const verifyToken = require('../middlewheres/verifyToken');

// ─── Public: token-based access for investigators (no login required) ─────────
// Declared before /:id to avoid route conflicts
router.get('/report/:token', controller.getReportForm);
router.post('/investigations/:investigationId/submit', controller.submitReport);

// ─── Admin: investigator CRUD ─────────────────────────────────────────────────
router.post('/create', verifyToken(), controller.createInvestigator);
router.get('/stats', verifyToken(), controller.getStats);
router.get('/', verifyToken(), controller.getAllInvestigators);
router.get('/:id', verifyToken(), controller.getInvestigator);
router.put('/:id', verifyToken(), controller.updateInvestigator);
router.delete('/:id', verifyToken(), controller.deleteInvestigator);

// ─── Admin: investigation workflow ───────────────────────────────────────────
router.post('/flag/:claimId', verifyToken(), controller.flagClaimAsFraud);
router.post('/investigations/:investigationId/appoint', verifyToken(), controller.appointInvestigator);
router.put('/investigations/:investigationId/review', verifyToken(), controller.reviewReport);
router.get('/my-investigations/:investigatorId', verifyToken(), controller.getMyInvestigations);
router.get('/investigations/all', verifyToken(), controller.getAllInvestigations);
router.get('/investigations/:investigationId', verifyToken(), controller.getInvestigation);

module.exports = router;
