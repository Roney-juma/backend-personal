const express = require('express');
const aiController = require('../controllers/aiAssistant.controller');
const verifyClaimToken = require('../middlewheres/verifyClaimToken');

const router = express.Router();

// Browser chat page — open this link to file a claim by chatting.
router.get('/claim-intake/:token', aiController.claimIntakePage);

// Conversational claim filing. Authenticated by the claim token (the secure
// link), NOT a JWT — so this router is intentionally not behind verifyToken.
router.post('/claim-intake/:token', verifyClaimToken, aiController.claimIntake);

module.exports = router;
