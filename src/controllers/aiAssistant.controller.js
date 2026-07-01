const { runClaimIntake } = require('../ai/agents/claimIntake.agent');
const { runStaffAssistant } = require('../ai/agents/staffAssistant.agent');
const { validatePhoto } = require('../ai/agents/photoValidator');
const { renderIntakePage } = require('../ai/intakePage');
const logger = require('../middlewheres/logger');

/**
 * GET /ai/claim-intake/:token
 * Serves the browser chat page. The page itself POSTs to the same path to talk
 * to the agent. Token validation happens on the POST (so the page can render
 * friendly errors in-chat).
 */
const claimIntakePage = (req, res) => {
  res.type('html').send(renderIntakePage(req.params.token));
};

/**
 * POST /ai/claim-intake/:token   (token-authenticated via verifyClaimToken)
 *
 * Body: { messages?: AnthropicMessage[], userMessage: string }
 *  - `messages`     : prior conversation returned by the previous response (opaque
 *                     to the client; empty/absent on the first turn).
 *  - `userMessage`  : the claimant's new message this turn.
 *
 * Returns: { messages, reply, status: 'collecting'|'submitted', claimId? }
 */
const claimIntake = async (req, res) => {
  try {
    const { messages = [], userMessage, images = [] } = req.body || {};
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ message: 'userMessage is required' });
    }

    const result = await runClaimIntake({
      customer: req.customer,
      token: req.claimToken.token,
      messages: Array.isArray(messages) ? messages : [],
      userMessage,
      images: Array.isArray(images) ? images : [],
      req,
    });

    res.status(200).json(result);
  } catch (err) {
    logger.error(`claimIntake error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Claim assistant error' });
  }
};

/**
 * POST /ai/claim-intake/:token/validate-photo   (token-authenticated)
 *
 * Multipart body: field `image`. Runs a cheap vision check and returns whether
 * the photo is claim-relevant. The intake page calls this BEFORE uploading to
 * S3, so irrelevant/junk images are rejected and never stored.
 *
 * Returns: { valid, category, quality, reason }
 */
const validateClaimPhoto = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'No image uploaded' });
    }
    const result = await validatePhoto(req.file.buffer, req.file.mimetype);
    res.status(200).json(result);
  } catch (err) {
    logger.error(`validateClaimPhoto error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Photo validation error' });
  }
};

/**
 * POST /ai/staff-assistant   (staff JWT via verifyToken)
 *
 * Body: { messages?: AnthropicMessage[], userMessage: string }
 * Returns: { messages, reply }   — read-only Q&A over operational data + KB.
 */
const staffAssistant = async (req, res) => {
  try {
    const { messages = [], userMessage } = req.body || {};
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ message: 'userMessage is required' });
    }
    const result = await runStaffAssistant({
      user: req.user,
      messages: Array.isArray(messages) ? messages : [],
      userMessage,
    });
    res.status(200).json(result);
  } catch (err) {
    logger.error(`staffAssistant error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Staff assistant error' });
  }
};

module.exports = { claimIntake, claimIntakePage, validateClaimPhoto, staffAssistant };
