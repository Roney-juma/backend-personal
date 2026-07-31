const express = require('express');
const aiController = require('../controllers/aiAssistant.controller');
const aiUsageController = require('../controllers/aiUsage.controller');
const verifyClaimToken = require('../middlewheres/verifyClaimToken');
const verifyToken = require('../middlewheres/verifyToken');
const Upload = require('../utils/upload');

const router = express.Router();

// ── Mobile-app claim intake (customer JWT) ─────────────────────────────────
// The logged-in customer drives the same conversational agent as the secure
// link, authenticated by their JWT instead of a one-time token. Registered
// BEFORE the ':token' routes so the literal '/claim-intake/validate-photo' path
// is matched here rather than captured as ':token'.
router.post('/claim-intake', verifyToken(), aiController.claimIntakeJwt);
router.post(
  '/claim-intake/validate-photo',
  verifyToken(),
  Upload.single('image'),
  aiController.validateClaimPhoto,
);

// Browser chat page — open this link to file a claim by chatting.
router.get('/claim-intake/:token', aiController.claimIntakePage);

// Saved conversation for this link (cross-device resume). Token-authenticated.
router.get('/claim-intake/:token/session', verifyClaimToken, aiController.getIntakeSession);

// Conversational claim filing. Authenticated by the claim token (the secure
// link), NOT a JWT — so this router is intentionally not behind verifyToken.
router.post('/claim-intake/:token', verifyClaimToken, aiController.claimIntake);

// Pre-upload photo gate: reject images that aren't claim-relevant (a vehicle,
// damage, accident scene, or supporting document) before they reach S3.
router.post(
  '/claim-intake/:token/validate-photo',
  verifyClaimToken,
  Upload.single('image'),
  aiController.validateClaimPhoto,
);

// Front-office staff Q&A assistant. Authenticated by staff JWT (read-only).
router.post('/staff-assistant', verifyToken(), aiController.staffAssistant);

// ── AI usage reporting (staff JWT) ─────────────────────────────────────────
// Full AI lifecycle cost of one claim, broken down by feature/stage.
router.get('/usage/claims/:claimId', verifyToken(), aiUsageController.claimCost);
// Period rollup: ?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month|feature|model|claim
router.get('/usage/report', verifyToken(), aiUsageController.report);

module.exports = router;
