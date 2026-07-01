const express = require('express');
const aiController = require('../controllers/aiAssistant.controller');
const verifyClaimToken = require('../middlewheres/verifyClaimToken');
const verifyToken = require('../middlewheres/verifyToken');

const router = express.Router();

// Browser chat page — open this link to file a claim by chatting.
router.get('/claim-intake/:token', aiController.claimIntakePage);

// Conversational claim filing. Authenticated by the claim token (the secure
// link), NOT a JWT — so this router is intentionally not behind verifyToken.
router.post('/claim-intake/:token', verifyClaimToken, aiController.claimIntake);

// Front-office staff Q&A assistant. Authenticated by staff JWT (read-only).
router.post('/staff-assistant', verifyToken(), aiController.staffAssistant);

module.exports = router;
