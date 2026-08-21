const express = require('express');
const portal = require('../service/advocatePortal.service');
const tokenService = require('../service/token.service');
const verifyToken = require('../middlewheres/verifyToken');
const authLimiter = require('../middlewheres/authLimiter');
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
    const token = tokenService.GenerateToken(advocate);

    await writeAuditLog(req, {
      action: 'LOGIN',
      module: 'Legal',
      actionDescription: `Advocate ${advocate.name} signed into the portal`,
      resourceType: 'Advocate',
      resourceId: advocate._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json({
      token,
      user: advocate.toJSON(),
      mustChangePassword: advocate.mustChangePassword,
    });
  } catch (error) {
    handle(res, error);
  }
});

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
