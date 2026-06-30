const ClaimToken = require('../models/claimToken.model');
const Customer = require('../models/customerModel');
const logger = require('./logger');

/**
 * Authenticates a claim-intake request by its claim token (the secure link is
 * the credential — no JWT). Validates the token exists, is unused and unexpired,
 * resolves the customer, and attaches both to the request.
 *
 * IMPORTANT: this does NOT consume the token. The token is only marked `used`
 * when the claim is actually filed (inside fileClaimService).
 */
const verifyClaimToken = async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Missing claim token' });

    const claimToken = await ClaimToken.findOne({ token });
    if (!claimToken) return res.status(401).json({ message: 'Invalid claim link' });
    if (claimToken.used) return res.status(410).json({ message: 'This claim link has already been used' });
    if (claimToken.expiresAt && claimToken.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ message: 'This claim link has expired' });
    }

    const customer = await Customer.findById(claimToken.customerId);
    if (!customer) return res.status(404).json({ message: 'Customer not found for this link' });

    req.claimToken = claimToken;
    req.customer = customer;
    next();
  } catch (err) {
    logger.error(`verifyClaimToken error: ${err.message}`);
    res.status(500).json({ message: 'Server error validating claim link' });
  }
};

module.exports = verifyClaimToken;
