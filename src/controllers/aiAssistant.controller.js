const { runClaimIntake } = require('../ai/agents/claimIntake.agent');
const logger = require('../middlewheres/logger');

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
    const { messages = [], userMessage } = req.body || {};
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ message: 'userMessage is required' });
    }

    const result = await runClaimIntake({
      customer: req.customer,
      token: req.claimToken.token,
      messages: Array.isArray(messages) ? messages : [],
      userMessage,
      req,
    });

    res.status(200).json(result);
  } catch (err) {
    logger.error(`claimIntake error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Claim assistant error' });
  }
};

module.exports = { claimIntake };
