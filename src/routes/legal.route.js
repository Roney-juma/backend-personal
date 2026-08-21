const express = require('express');
const controller = require('../controllers/legal.controller');
const settlement = require('../controllers/settlement.controller');
const litigation = require('../controllers/litigation.controller');
const recovery = require('../controllers/recovery.controller');
const referral = require('../controllers/legalReferral.controller');
const Upload = require('../utils/upload');
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

// ── Referral ─────────────────────────────────────────────────────────────────
// How an EXISTING claim reaches Legal — spec §5. A referral is a request, not
// an instruction: raising is a claims-side act, accepting is a legal-side one,
// and only accepting marks the claim as a legal matter.

// The trigger catalogue, for the configuration screen. Before '/referrals/:id'.
router.get(
  '/referrals/triggers',
  verifyToken(),
  requirePermission('VIEW_LEGAL_CASES'),
  referral.availableTriggers
);

router.get('/referrals', verifyToken(), requirePermission('VIEW_LEGAL_CASES'), referral.list);
router.post('/referrals', verifyToken(), requirePermission('CREATE_LEGAL_REFERRAL'), referral.raise);
router.get('/referrals/:id', verifyToken(), requirePermission('VIEW_LEGAL_CASES'), referral.getById);

// Legal decides. Separate permission from raising, deliberately.
router.post('/referrals/:id/accept', verifyToken(), requirePermission('APPROVE_LEGAL_REFERRAL'), referral.accept);
router.post('/referrals/:id/return', verifyToken(), requirePermission('APPROVE_LEGAL_REFERRAL'), referral.returnToClaims);
// The raiser can pull their own back.
router.post('/referrals/:id/withdraw', verifyToken(), requirePermission('CREATE_LEGAL_REFERRAL'), referral.withdraw);

// Raise straight from a claim — the path the claims screen uses.
router.post(
  '/claims/:claimId/refer',
  verifyToken(),
  requirePermission('CREATE_LEGAL_REFERRAL'),
  referral.raise
);

// Dry-run the triggers against one claim without referring anything, so a
// tenant can see why a claim would or would not be picked up before enabling.
router.get(
  '/claims/:claimId/referral-check',
  verifyToken(),
  requirePermission('VIEW_LEGAL_CASES'),
  referral.evaluateClaim
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

// ── Approvals ────────────────────────────────────────────────────────────────

// The queue, annotated with what the caller can actually decide.
router.get(
  '/approvals',
  verifyToken(),
  requirePermission('VIEW_SETTLEMENTS'),
  settlement.listApprovals
);

// "Who would have to sign this off?" — before committing to a figure.
router.get(
  '/approvals/preview',
  verifyToken(),
  requirePermission('PROPOSE_SETTLEMENT'),
  settlement.previewAuthority
);

// ── Reports ──────────────────────────────────────────────────────────────────
router.get('/reports/monthly', verifyToken(), requirePermission('VIEW_LEGAL_REPORTS'), settlement.monthlyReport);
router.get('/reports/aging', verifyToken(), requirePermission('VIEW_LEGAL_REPORTS'), settlement.agingReport);
router.get(
  '/reports/reserving-accuracy',
  verifyToken(),
  requirePermission('VIEW_LEGAL_REPORTS'),
  settlement.reservingAccuracyReport
);

// ── Settlements ──────────────────────────────────────────────────────────────
router.get('/settlements', verifyToken(), requirePermission('VIEW_SETTLEMENTS'), settlement.list);
router.post('/settlements', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.propose);
router.get('/settlements/:id', verifyToken(), requirePermission('VIEW_SETTLEMENTS'), settlement.getById);

// Negotiation — recording their counter is not an authority decision.
router.post('/settlements/:id/offers', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.addOffer);
router.post('/settlements/:id/submit', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.submitForApproval);

/**
 * Two gates on a decision, deliberately: this permission says whether you may
 * approve settlements at all, and the tenant's authority matrix (checked in
 * approval.service) says whether you may approve THIS amount. A Claims Manager
 * holding the permission still cannot sign off a figure reserved for the CEO.
 */
router.post('/settlements/:id/decide', verifyToken(), requirePermission('APPROVE_SETTLEMENT'), settlement.decide);
router.post('/settlements/:id/escalate', verifyToken(), requirePermission('APPROVE_SETTLEMENT'), settlement.escalate);

router.post('/settlements/:id/claimant-response', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.recordClaimantResponse);
router.post('/settlements/:id/execute', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.execute);
router.post('/settlements/:id/request-payment', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.requestPayment);

// Finance moves the money.
router.post('/settlements/:id/pay', verifyToken(), requirePermission('APPROVE_LEGAL_PAYMENT'), settlement.markPaid);

router.post('/settlements/:id/withdraw', verifyToken(), requirePermission('PROPOSE_SETTLEMENT'), settlement.withdraw);

// ── Court diary ──────────────────────────────────────────────────────────────
// Before '/cases/:id' so it is not swallowed as an id lookup.
router.get('/diary', verifyToken(), requirePermission('VIEW_LEGAL_DIARY'), litigation.getDiary);
router.post('/diary', verifyToken(), requirePermission('MANAGE_LEGAL_DIARY'), litigation.createEvent);

// An adjournment closes the entry and creates its successor — never a date edit,
// because the pattern of adjournments is what court-performance reporting reads.
router.post('/diary/:eventId/adjourn', verifyToken(), requirePermission('MANAGE_LEGAL_DIARY'), litigation.adjournEvent);
router.post('/diary/:eventId/complete', verifyToken(), requirePermission('MANAGE_LEGAL_DIARY'), litigation.completeEvent);
router.post('/diary/:eventId/cancel', verifyToken(), requirePermission('MANAGE_LEGAL_DIARY'), litigation.cancelEvent);

// ── Advocate panel ───────────────────────────────────────────────────────────
router.get('/advocates', verifyToken(), requirePermission('VIEW_ADVOCATES'), litigation.listAdvocates);
router.post('/advocates', verifyToken(), requirePermission('CREATE_ADVOCATE'), litigation.createAdvocate);

// Ranked / random suggestion. Before '/advocates/:id'.
router.get('/advocates/suggest', verifyToken(), requirePermission('ALLOCATE_ADVOCATE'), litigation.suggestAdvocate);

router.get('/advocates/:id', verifyToken(), requirePermission('VIEW_ADVOCATES'), litigation.getAdvocate);
router.put('/advocates/:id', verifyToken(), requirePermission('UPDATE_ADVOCATE'), litigation.updateAdvocate);
router.post('/advocates/:id/approval', verifyToken(), requirePermission('UPDATE_ADVOCATE'), litigation.setAdvocateApproval);
router.post('/advocates/:id/suspend', verifyToken(), requirePermission('UPDATE_ADVOCATE'), litigation.suspendAdvocate);
router.post('/advocates/:id/recompute', verifyToken(), requirePermission('VIEW_ADVOCATES'), litigation.recomputeAdvocatePerformance);
router.post('/advocates/:id/credentials', verifyToken(), requirePermission('UPDATE_ADVOCATE'), litigation.issueAdvocateCredentials);

// ── Documents ────────────────────────────────────────────────────────────────
router.get('/documents', verifyToken(), requirePermission('VIEW_LEGAL_DOCUMENTS'), litigation.listDocuments);
router.post(
  '/documents',
  verifyToken(),
  requirePermission('UPLOAD_LEGAL_DOCUMENT'),
  Upload.single('file'),
  litigation.uploadDocument
);

/**
 * Downloads are API-mediated on purpose: the service checks the privilege class,
 * mints a short-lived signed link, and logs the attempt — refusals included.
 * Spec §22's access history only means anything if this is the only door, which
 * is why the storage key never leaves the server.
 */
router.get(
  '/documents/:documentId/download',
  verifyToken(),
  requirePermission('VIEW_LEGAL_DOCUMENTS'),
  litigation.downloadDocument
);
router.get(
  '/documents/:documentId/access-log',
  verifyToken(),
  requirePermission('VIEW_LEGAL_DOCUMENTS'),
  litigation.documentAccessLog
);
router.post(
  '/documents/:documentId/reclassify',
  verifyToken(),
  requirePermission('VIEW_PRIVILEGED_DOCUMENTS'),
  litigation.reclassifyDocument
);
router.post(
  '/documents/:documentId/filed',
  verifyToken(),
  requirePermission('UPLOAD_LEGAL_DOCUMENT'),
  litigation.markDocumentFiled
);

// ── Legal cases (litigation) ─────────────────────────────────────────────────
router.get('/cases', verifyToken(), requirePermission('VIEW_LEGAL_CASES'), litigation.listCases);
router.post('/cases', verifyToken(), requirePermission('CREATE_LEGAL_REFERRAL'), litigation.createCase);
router.get('/cases/:id', verifyToken(), requirePermission('VIEW_LEGAL_CASES'), litigation.getCase);
router.get('/cases/:id/diary', verifyToken(), requirePermission('VIEW_LEGAL_DIARY'), litigation.getCaseDiary);
router.post('/cases/:id/appoint-advocate', verifyToken(), requirePermission('APPOINT_ADVOCATE'), litigation.appointAdvocate);
router.get('/cases/:id/instruction-pack', verifyToken(), requirePermission('VIEW_LEGAL_CASES'), litigation.instructionPack);
router.post('/cases/:id/instructions', verifyToken(), requirePermission('UPDATE_LEGAL_CASE'), litigation.issueInstructions);
router.post('/cases/:id/judgment', verifyToken(), requirePermission('UPDATE_LEGAL_CASE'), litigation.recordJudgment);
router.post('/cases/:id/appeal', verifyToken(), requirePermission('CREATE_LEGAL_REFERRAL'), litigation.createAppeal);
router.post('/cases/:id/close', verifyToken(), requirePermission('CLOSE_LEGAL_CASE'), litigation.closeCase);

// ── Recovery (subrogation) ───────────────────────────────────────────────────
// The mirror image of a third-party claim: us recovering from whoever was at
// fault. Money moves the other way and posts as credits to the same ledger.
router.get('/recoveries', verifyToken(), requirePermission('VIEW_RECOVERIES'), recovery.list);
router.post('/recoveries', verifyToken(), requirePermission('MANAGE_RECOVERY'), recovery.create);

// Before '/recoveries/:id'.
router.get('/recoveries/position', verifyToken(), requirePermission('VIEW_RECOVERIES'), recovery.position);
// Recoveries nobody has chased — where recovery money is actually lost.
router.get('/recoveries/stale', verifyToken(), requirePermission('VIEW_RECOVERIES'), recovery.stale);

router.get('/recoveries/:id', verifyToken(), requirePermission('VIEW_RECOVERIES'), recovery.getById);
router.post('/recoveries/:id/chase', verifyToken(), requirePermission('MANAGE_RECOVERY'), recovery.chase);
router.post('/recoveries/:id/agree', verifyToken(), requirePermission('MANAGE_RECOVERY'), recovery.agree);
router.post('/recoveries/:id/receipt', verifyToken(), requirePermission('MANAGE_RECOVERY'), recovery.recordReceipt);
router.post('/recoveries/:id/expense', verifyToken(), requirePermission('MANAGE_RECOVERY'), recovery.recordExpense);

// A write-off stops pursuing money the insurer is owed, so it sits behind
// payment authority rather than ordinary recovery management.
router.post('/recoveries/:id/write-off', verifyToken(), requirePermission('APPROVE_LEGAL_PAYMENT'), recovery.writeOff);

// ── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics/courts', verifyToken(), requirePermission('VIEW_LEGAL_REPORTS'), recovery.courtPerformance);
router.get('/analytics/advocates', verifyToken(), requirePermission('VIEW_LEGAL_REPORTS'), recovery.advocateScorecard);
// The feedback loop: what claims actually settle at, against the tenant's own
// reserving schedule.
router.get('/analytics/reserving', verifyToken(), requirePermission('VIEW_LEGAL_REPORTS'), recovery.reservingFeedback);

// ── Risk & assistant ─────────────────────────────────────────────────────────
router.post(
  '/third-party-claims/:id/risk',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  recovery.scoreRisk
);
router.get(
  '/third-party-claims/:id/similar',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  recovery.similarMatters
);

/**
 * The AI legal assistant. Read-only by construction — it holds no tool that
 * writes — and its output is a draft for a Legal Officer, never advice or an
 * authorisation. See ai/agents/legalAssistant.agent.js.
 */
router.post(
  '/assistant',
  verifyToken(),
  requirePermission('VIEW_THIRD_PARTY_CLAIMS'),
  recovery.askAssistant
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
