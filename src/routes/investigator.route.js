const express = require('express');
const router = express.Router();
const controller = require('../controllers/investigator.controller');
const verifyToken = require('../middlewheres/verifyToken');
const requirePortalUser = require('../middlewheres/requirePortalUser');
const requirePermission = require('../middlewheres/requirePermission');

// ─── Public: token-based access for investigators (no login required) ─────────
// Declared before /:id to avoid route conflicts
router.get('/report/:token', controller.getReportForm);
router.post('/investigations/:investigationId/submit', controller.submitReport);

// ─── Admin: investigator CRUD ─────────────────────────────────────────────────
// Portal-only: investigators themselves have no login (secure-link access above),
// and a mobile actor token would resolve to no requester company (global scope).
router.post('/create', verifyToken(), requirePortalUser, requirePermission('CREATE_INVESTIGATOR'), controller.createInvestigator);
router.get('/stats', verifyToken(), requirePortalUser, requirePermission('VIEW_INVESTIGATORS'), controller.getStats);
router.get('/', verifyToken(), requirePortalUser, requirePermission('VIEW_INVESTIGATORS'), controller.getAllInvestigators);
router.get('/:id', verifyToken(), requirePortalUser, requirePermission('VIEW_INVESTIGATORS'), controller.getInvestigator);
router.put('/:id', verifyToken(), requirePortalUser, requirePermission('UPDATE_INVESTIGATOR'), controller.updateInvestigator);
router.delete('/:id', verifyToken(), requirePortalUser, requirePermission('DELETE_INVESTIGATOR'), controller.deleteInvestigator);

// ─── Admin: investigation workflow ───────────────────────────────────────────
router.post('/flag/:claimId', verifyToken(), requirePortalUser, requirePermission('FLAG_FRAUD'), controller.flagClaimAsFraud);
router.post('/investigations/:investigationId/appoint', verifyToken(), requirePortalUser, requirePermission('ASSIGN_INVESTIGATION'), controller.appointInvestigator);
router.put('/investigations/:investigationId/review', verifyToken(), requirePortalUser, requirePermission('REVIEW_INVESTIGATION'), controller.reviewReport);
router.get('/my-investigations/:investigatorId', verifyToken(), requirePortalUser, requirePermission('VIEW_INVESTIGATORS'), controller.getMyInvestigations);
router.get('/investigations/all', verifyToken(), requirePortalUser, requirePermission('VIEW_INVESTIGATORS'), controller.getAllInvestigations);
router.get('/investigations/:investigationId', verifyToken(), requirePortalUser, requirePermission('VIEW_INVESTIGATORS'), controller.getInvestigation);

module.exports = router;
