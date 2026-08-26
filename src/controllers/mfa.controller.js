const mfaService = require('../service/mfa.service');
const tokenService = require('../service/token.service');
const { writeAuditLog } = require('../utils/auditHelper');

// For setup/enable/disable the account type is bound at the route layer (not read
// from the token): 'User' = insurer portal (ave_frontend), 'ProviderUser' =
// provider portal, plus the mobile actor types on their own route groups.

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
    // Audit only insurer-portal admins ('User') — mobile actor self-service
    // toggles would just be noise in the tenant's admin audit report.
    if (accountType === 'User') {
      await writeAuditLog(req, {
        action: 'UPDATE',
        module: 'Auth',
        actionDescription: 'Enabled MFA',
        resourceType: 'User',
        resourceId: req.user.id,
        statusCode: 200,
        success: true,
      });
    }
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
    // Audit only insurer-portal admins ('User') — see enable() above.
    if (accountType === 'User') {
      await writeAuditLog(req, {
        action: 'UPDATE',
        module: 'Auth',
        actionDescription: 'Disabled MFA',
        resourceType: 'User',
        resourceId: req.user.id,
        statusCode: 200,
        success: true,
      });
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Second login step — verifies the challenge token + TOTP code, issues real tokens. (public)
// The access token MUST match the account type bound into the challenge token:
// a customer/garage completing MFA must never receive a portal-stamped token.
const verifyLogin = async (req, res) => {
  try {
    const { mfaToken, code } = req.body;
    if (!mfaToken || !code) {
      return res.status(400).json({ message: 'mfaToken and code are required' });
    }
    const { user, accountType } = await mfaService.verifyLoginChallenge(mfaToken, code);
    let tokens;
    if (accountType === 'ProviderUser') {
      tokens = tokenService.generateProviderUserToken(user);
    } else if (accountType === 'User') {
      tokens = tokenService.generateCompanyUserToken(user);
    } else {
      // Customer / Garage / Assessor / Supplier / Advocate — the same token
      // their password login issues.
      tokens = tokenService.GenerateToken(user);
    }
    res.status(200).json({ user, tokens });
  } catch (err) {
    res.status(401).json({ message: err.message });
  }
};

module.exports = { setup, enable, disable, verifyLogin };
