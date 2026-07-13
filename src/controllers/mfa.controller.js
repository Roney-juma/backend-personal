const mfaService = require('../service/mfa.service');
const tokenService = require('../service/token.service');

// The account type is bound at the route layer (not read from the token) because
// both portals issue tokens with accountType 'ProviderUser' but map to different
// models: 'User' = insurer portal (ave_frontend), 'ProviderUser' = provider portal.

// Begin enrollment — returns otpauth URL + secret for the QR code. (authenticated)
const setup = (accountType) => async (req, res) => {
  try {
    const result = await mfaService.beginEnrollment(accountType, req.user.id, req.user.email);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Confirm enrollment — verifies the first code and enables MFA. (authenticated)
const enable = (accountType) => async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Verification code is required' });
    const result = await mfaService.confirmEnrollment(accountType, req.user.id, code);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Disable MFA — requires a valid current code. (authenticated)
const disable = (accountType) => async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Verification code is required' });
    const result = await mfaService.disable(accountType, req.user.id, code);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Second login step — verifies the challenge token + TOTP code, issues real tokens. (public)
const verifyLogin = async (req, res) => {
  try {
    const { mfaToken, code } = req.body;
    if (!mfaToken || !code) {
      return res.status(400).json({ message: 'mfaToken and code are required' });
    }
    const user = await mfaService.verifyLoginChallenge(mfaToken, code);
    const tokens = tokenService.generateProviderUserToken(user);
    res.status(200).json({ user, tokens });
  } catch (err) {
    res.status(401).json({ message: err.message });
  }
};

module.exports = { setup, enable, disable, verifyLogin };
