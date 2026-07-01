const { runClaimIntake } = require('../ai/agents/claimIntake.agent');
const { runStaffAssistant } = require('../ai/agents/staffAssistant.agent');
const { validatePhoto, validatePhotoUrl } = require('../ai/agents/photoValidator');
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
 * Body: { messages?: AnthropicMessage[], userMessage: string, images?: string[] }
 *  - `messages`     : prior conversation returned by the previous response (opaque
 *                     to the client; empty/absent on the first turn).
 *  - `userMessage`  : the claimant's new message this turn.
 *  - `images`       : URLs of photos attached this turn.
 *
 * Every attached photo is validated SERVER-SIDE here (not just in the browser),
 * so irrelevant images can't reach the claim regardless of which frontend or
 * upload path was used. If any photo is irrelevant, the turn is rejected and
 * nothing is recorded.
 *
 * Returns: { messages, reply, status: 'collecting'|'submitted', claimId? }
 */
const claimIntake = async (req, res) => {
  try {
    const { messages = [], userMessage, images = [] } = req.body || {};
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ message: 'userMessage is required' });
    }

    const priorMessages = Array.isArray(messages) ? messages : [];
    const photoUrls = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u);

    // Server-side photo gate: reject the turn if any attached photo is not a
    // vehicle, damage, accident scene, or supporting document.
    if (photoUrls.length > 0) {
      const checks = await Promise.all(photoUrls.map((url) => validatePhotoUrl(url)));
      const rejected = checks.filter((c) => !c.valid);
      if (rejected.length > 0) {
        const reason = rejected[0].reason || "that photo doesn't look claim-related";
        return res.status(200).json({
          messages: priorMessages, // don't record the rejected photo
          reply:
            `I couldn't use ${rejected.length > 1 ? 'those photos' : 'that photo'} — ${reason} ` +
            'Please send a clear photo of the vehicle, the damage, the accident scene, or a document ' +
            '(driving licence, insurance sticker).',
          status: 'collecting',
        });
      }
    }

    const result = await runClaimIntake({
      customer: req.customer,
      token: req.claimToken.token,
      messages: priorMessages,
      userMessage,
      images: photoUrls,
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
