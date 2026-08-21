const express = require('express');
const controller = require('../controllers/legal.controller');
const verifyToken = require('../middlewheres/verifyToken');
const requirePermission = require('../middlewheres/requirePermission');

const router = express.Router();

/**
 * Legal & Litigation — third-party liability.
 *
 * Mounted at /legal. Every route is authenticated and permission-gated; the
 * tenant is taken from the token inside the controller, never from the body.
 *
 * Note the separate permissions on liability and quantum: those two numbers
 * decide what the insurer pays, so they belong to trained assessors rather than
 * to anyone who happens to hold a general update permission.
 */

// ── Dashboard & config ───────────────────────────────────────────────────────
router.get('/dashboard', verifyToken(), requirePermission('VIEW_THIRD_PARTY_CLAIMS'), controller.getDashboard);
router.get('/config', verifyToken(), requirePermission('VIEW_LEGAL_REPORTS'), controller.getConfig);
router.put('/config', verifyToken(), requirePermission('MANAGE_LEGAL_CONFIG'), controller.updateConfig);

// ── Intake ───────────────────────────────────────────────────────────────────

// Look before creating: match an incoming demand to accidents already on file
// and to the policy in force. Registered before '/third-party-claims/:id' so it
// is never swallowed as an id lookup.
router.get(
  '/demands/match',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  controller.matchDemand
);

// Record a demand — opens the accident record too when the insured never
// reported it. Needs CREATE_CLAIM as well as CREATE_THIRD_PARTY_CLAIM precisely
// because it can create a claim.
router.post(
  '/demands',
  verifyToken(),
  requirePermission('CREATE_THIRD_PARTY_CLAIM'),
  controller.recordDemand
);

// Merge a third-party notification into the insured's later report of the same
// accident, rather than carrying two files for one event.
router.post(
  '/claims/merge',
  verifyToken(),
  requirePermission('UPDATE_CLAIM'),
  controller.mergeClaims
);

// ── Time-bar register ────────────────────────────────────────────────────────
// Before '/third-party-claims/:id' for the same reason as above.
router.get(
  '/time-bar',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  controller.getTimeBarRegister
);

// ── Third-party claims ───────────────────────────────────────────────────────
router.get(
  '/third-party-claims',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  controller.listThirdPartyClaims
);
router.post(
  '/third-party-claims',
  verifyToken(),
  requirePermission('CREATE_THIRD_PARTY_CLAIM'),
  controller.registerThirdPartyClaim
);
router.get(
  '/third-party-claims/:id',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  controller.getThirdPartyClaim
);
router.put(
  '/third-party-claims/:id',
  verifyToken(),
  requirePermission('UPDATE_THIRD_PARTY_CLAIM'),
  controller.updateThirdPartyClaim
);

// Assessment — the two numbers that drive everything downstream.
router.post(
  '/third-party-claims/:id/liability',
  verifyToken(),
  requirePermission('ASSESS_LIABILITY'),
  controller.assessLiability
);
router.post(
  '/third-party-claims/:id/quantum',
  verifyToken(),
  requirePermission('ASSESS_QUANTUM'),
  controller.assessQuantum
);

// Reserve. Departing from the company's own reserving schedule additionally
// requires a reason, enforced in the service.
router.post(
  '/third-party-claims/:id/reserve',
  verifyToken(),
  requirePermission('SET_LEGAL_RESERVE'),
  controller.setReserve
);

router.get(
  '/third-party-claims/:id/exposure',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  controller.getExposure
);
router.get(
  '/third-party-claims/:id/financials',
  verifyToken(),
  requirePermission('VIEW_LEGAL_FINANCIALS'),
  controller.getFinancials
);
router.post(
  '/third-party-claims/:id/limitation/extend',
  verifyToken(),
  requirePermission('MANAGE_LEGAL_DEADLINES'),
  controller.extendLimitation
);

// ── Per-accident ─────────────────────────────────────────────────────────────

// Register a claimant against an accident already on file.
router.post(
  '/claims/:claimId/third-party-claims',
  verifyToken(),
  requirePermission('CREATE_THIRD_PARTY_CLAIM'),
  controller.registerThirdPartyClaim
);

// Aggregate exposure across every claimant on one accident, against the policy
// aggregate limit — where limit erosion actually shows up.
router.get(
  '/claims/:claimId/exposure',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  controller.getAccidentExposure
);

module.exports = router;
