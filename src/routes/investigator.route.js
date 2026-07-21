const express = require('express');
const router = express.Router();
const controller = require('../controllers/investigator.controller');
const verifyToken = require('../middlewheres/verifyToken');
const requirePortalUser = require('../middlewheres/requirePortalUser');

// ─── Public: token-based access for investigators (no login required) ─────────
// Declared before /:id to avoid route conflicts
router.get('/report/:token', controller.getReportForm);
router.post('/investigations/:investigationId/submit', controller.submitReport);

// ─── Admin: investigator CRUD ─────────────────────────────────────────────────
// Portal-only: investigators themselves have no login (secure-link access above),
// and a mobile actor token would resolve to no requester company (global scope).
router.post('/create', verifyToken(), requirePortalUser, controller.createInvestigator);
router.get('/stats', verifyToken(), requirePortalUser, controller.getStats);
router.get('/', verifyToken(), requirePortalUser, controller.getAllInvestigators);
router.get('/:id', verifyToken(), requirePortalUser, controller.getInvestigator);
router.put('/:id', verifyToken(), requirePortalUser, controller.updateInvestigator);
router.delete('/:id', verifyToken(), requirePortalUser, controller.deleteInvestigator);

// ─── Admin: investigation workflow ───────────────────────────────────────────
router.post('/flag/:claimId', verifyToken(), requirePortalUser, controller.flagClaimAsFraud);
router.post('/investigations/:investigationId/appoint', verifyToken(), requirePortalUser, controller.appointInvestigator);
router.put('/investigations/:investigationId/review', verifyToken(), requirePortalUser, controller.reviewReport);
router.get('/my-investigations/:investigatorId', verifyToken(), requirePortalUser, controller.getMyInvestigations);
router.get('/investigations/all', verifyToken(), requirePortalUser, controller.getAllInvestigations);
router.get('/investigations/:investigationId', verifyToken(), requirePortalUser, controller.getInvestigation);

module.exports = router;
