const express = require('express');
const portal = require('../service/advocatePortal.service');
const tokenService = require('../service/token.service');
const verifyToken = require('../middlewheres/verifyToken');
const authLimiter = require('../middlewheres/authLimiter');
const passwordController = require('../controllers/password.controller');
const mfaController = require('../controllers/mfa.controller');
const Upload = require('../utils/upload');
const { writeAuditLog } = require('../utils/auditHelper');

const router = express.Router();

/**
 * Advocate portal — the panel advocate's own surface, served to partner-fe.
 *
 * Mounted at /advocate-portal. Distinct from /legal, which is the insurer's
 * staff surface: nothing here is permission-gated by the RBAC catalog, because
 * an advocate holds no staff permissions at all. Scope comes from the token's
 * identity and is enforced inside the service on every call.
 *
 * Deliberately absent: anything touching our reserve, exposure, quantum
 * assessment or ledger. Those are privileged.
 */

/** Guard: the token must actually belong to an advocate. */
const requireAdvocate = (req, res, next) => {
  if (req.user?.accountType !== 'Advocate') {
    return res.status(403).json({ message: 'This area is for panel advocates' });
  }
  next();
};

const handle = (res, error) =>
  res.status(error.statusCode || 400).json({ message: error.message });

// ── Auth ─────────────────────────────────────────────────────────────────────

router.post('/login', authLimiter, async (req, res) => {
  try {
    const advocate = await portal.login(req.body.email, req.body.password);

    // Same challenge shape the assessor and garage logins use, so the partner
    // shell's existing MFA step works here unchanged. Without this the MFA
    // routes below would let counsel enable a second factor that sign-in never
    // asked for — worse than not offering it at all.
    if (advocate.mfaEnabled) {
      const mfaToken = tokenService.generateMfaChallengeToken(advocate._id, 'Advocate');
      return res.status(200).json({ mfaRequired: true, mfaToken });
    }

    const tokens = tokenService.GenerateToken(advocate);

    await writeAuditLog(req, {
      action: 'LOGIN',
      module: 'Legal',
      actionDescription: `Advocate ${advocate.name} signed into the portal`,
      resourceType: 'Advocate',
      resourceId: advocate._id,
      statusCode: 200,
      success: true,
    });

    /**
     * `tokens`, not `token`. The assessor and garage logins both return
     * { user, tokens }, and the partner shell reads `data.tokens` — so the
     * singular spelling here meant counsel signed in, was handed nothing the
     * client could store, and had every authenticated call rejected after it.
     * mustChangePassword also rides on the user document; it is repeated at the
     * top level only because the first version of this response put it there.
     */
    res.status(200).json({
      user: advocate.toJSON(),
      tokens,
      mustChangePassword: advocate.mustChangePassword,
    });
  } catch (error) {
    handle(res, error);
  }
});

/**
 * Password recovery and the forced first-login change.
 *
 * These exist because an advocate is emailed a temporary password when they
 * join a panel and must change it before doing anything. Without them the
 * partner shell sends counsel to a change-password screen with no endpoint
 * behind it, and a mislaid password becomes a support call to the insurer.
 *
 * change-password and the MFA routes run on the shared controllers that already
 * serve assessors and garages: Advocate is registered in utils/userModels.js,
 * so none of that logic is duplicated here.
 */
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    if (!req.body.email) return res.status(400).json({ message: 'Email is required' });
    res.status(200).json(await portal.forgotPassword(req.body.email));
  } catch (error) {
    handle(res, error);
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ message: 'Email, token and newPassword are required' });
    }
    res.status(200).json(await portal.resetPassword(email, token, newPassword));
  } catch (error) {
    handle(res, error);
  }
});

router.post(
  '/change-password',
  verifyToken(),
  requireAdvocate,
  passwordController.changePassword('Advocate')
);

// ── Own profile ──────────────────────────────────────────────────────────────
// Contact details only. Panel standing — approval, rates, contract terms — is
// the insurer's to set, and the id comes from the token, never the request.
router.put('/profile', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const advocate = await portal.updateProfile(req.user.id, req.body);
    res.status(200).json(advocate.toJSON());
  } catch (error) {
    handle(res, error);
  }
});

// ── MFA ──────────────────────────────────────────────────────────────────────
// verify-login is pre-authentication by nature; the rest act on the caller's
// own account, which is why they are bound to 'Advocate' at this layer.
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);
router.post('/mfa/setup', verifyToken(), requireAdvocate, mfaController.setup('Advocate'));
router.post('/mfa/enable', verifyToken(), requireAdvocate, mfaController.enable('Advocate'));
router.post('/mfa/disable', verifyToken(), requireAdvocate, mfaController.disable('Advocate'));

// ── Matters ──────────────────────────────────────────────────────────────────

router.get('/cases', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    res.status(200).json(await portal.myCases(req.user.id, req.query));
  } catch (error) {
    handle(res, error);
  }
});

router.get('/cases/:id', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    res.status(200).json(await portal.caseDetail(req.user.id, req.params.id, req.user));
  } catch (error) {
    handle(res, error);
  }
});

router.post('/cases/:id/accept-instructions', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const legalCase = await portal.acceptInstructions(req.user.id, req.params.id);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Counsel accepted instructions on ${legalCase.caseNumber}`,
      resourceType: 'LegalCase',
      resourceId: legalCase._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(legalCase);
  } catch (error) {
    handle(res, error);
  }
});

// ── Diary ────────────────────────────────────────────────────────────────────

// Counsel is in the room when a date is given — this is the fastest and most
// reliable path into the diary, and the main reason the portal exists.
router.get('/diary', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    res.status(200).json(await portal.myDiary(req.user.id, req.query));
  } catch (error) {
    handle(res, error);
  }
});

router.post('/cases/:id/court-dates', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const event = await portal.addCourtDate(req.user.id, req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription: `Counsel diarised "${event.title}" for ${new Date(event.dueAt).toDateString()}`,
      resourceType: 'LegalEvent',
      resourceId: event._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(event);
  } catch (error) {
    handle(res, error);
  }
});

router.post('/diary/:eventId/adjourn', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const result = await portal.adjournCourtDate(req.user.id, req.params.eventId, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Counsel adjourned "${result.adjourned.title}" to ` +
        `${new Date(result.successor.dueAt).toDateString()}`,
      resourceType: 'LegalEvent',
      resourceId: result.adjourned._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(result);
  } catch (error) {
    handle(res, error);
  }
});

// ── Reporting back ───────────────────────────────────────────────────────────

router.post('/cases/:id/progress-report', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const legalCase = await portal.submitProgressReport(req.user.id, req.params.id, req.body);
    res.status(200).json({ message: 'Progress report submitted', caseNumber: legalCase.caseNumber });
  } catch (error) {
    handle(res, error);
  }
});

/**
 * Conclude the matter.
 *
 * Counsel initiates this, not the insurer — they were in court and are the only
 * ones who can state the outcome and whether an appeal is advised. It records
 * the report and notifies the legal team; the matter is closed separately,
 * through the closure checklist.
 */
router.post('/cases/:id/closing-report', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const { legalCase, notified } = await portal.submitClosingReport(
      req.user.id,
      req.params.id,
      req.body
    );
    res.status(200).json({
      message: 'Closing report submitted — the legal team has been notified',
      caseNumber: legalCase.caseNumber,
      closingReport: legalCase.closingReport,
      notified,
    });
  } catch (error) {
    handle(res, error);
  }
});

/**
 * Request settlement authority. Counsel asks; the insurer's authority matrix
 * decides. This creates no ApprovalRequest — an advocate's view of value is
 * advice, and becomes a proposal only when a Legal Officer adopts it.
 */
router.post('/cases/:id/authority-request', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    const result = await portal.requestAuthority(req.user.id, req.params.id, req.body);
    res.status(200).json({ message: 'Authority request sent to the legal team', ...result });
  } catch (error) {
    handle(res, error);
  }
});

// ── Documents ────────────────────────────────────────────────────────────────

// Uploads are forced to advocate_shared regardless of what is posted — counsel
// cannot classify a document as internal or privileged to us.
router.post(
  '/cases/:id/documents',
  verifyToken(),
  requireAdvocate,
  Upload.single('file'),
  async (req, res) => {
    try {
      const document = await portal.uploadDocument(
        req.user.id,
        req.params.id,
        { file: req.file, meta: req.body },
        req.user
      );
      res.status(201).json({ ...document.toObject(), storageKey: undefined });
    } catch (error) {
      handle(res, error);
    }
  }
);

router.get('/documents/:documentId/download', verifyToken(), requireAdvocate, async (req, res) => {
  try {
    res.status(200).json(
      await portal.downloadDocument(req.user.id, req.params.documentId, req.user, req)
    );
  } catch (error) {
    handle(res, error);
  }
});

module.exports = router;
