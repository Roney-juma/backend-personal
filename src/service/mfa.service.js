const jwt = require('jsonwebtoken');
const totp = require('../utils/totp');
const { TokenIssuer } = require('../constants/encryption.constants');
const { readPublicKey } = require('../config/keys');
const MODELS = require('../utils/userModels');

const publicKey = readPublicKey();

// One MFA service serves every account type (portal staff + mobile users)
// via the shared model registry.
const getModel = (accountType) => {
  const model = MODELS[accountType];
  if (!model) throw new Error(`Unsupported account type for MFA: ${accountType}`);
  return model;
};

// Step 1 of enrollment: generate a secret and store it (not yet enabled).
// Returns the otpauth URI + secret so the frontend can render a QR code.
const beginEnrollment = async (accountType, userId, accountName) => {
  const Model = getModel(accountType);
  const user = await Model.findById(userId);
  if (!user) throw new Error('User not found');

  const secret = totp.generateSecret();
  user.mfaSecret = secret;
  user.mfaEnabled = false; // stays disabled until the first code is verified
  await user.save();

  return {
    secret,
    otpauthUrl: totp.keyUri(secret, accountName || user.email),
  };
};

// Step 2 of enrollment: verify the first code, then flip MFA on.
const confirmEnrollment = async (accountType, userId, code) => {
  const Model = getModel(accountType);
  const user = await Model.findById(userId);
  if (!user || !user.mfaSecret) throw new Error('MFA setup has not been started');

  if (!totp.verify(code, user.mfaSecret)) {
    throw new Error('Invalid verification code');
  }

  user.mfaEnabled = true;
  await user.save();
  return { mfaEnabled: true };
};

// Disable MFA (requires a valid current code to prevent hijack of the setting).
const disable = async (accountType, userId, code) => {
  const Model = getModel(accountType);
  const user = await Model.findById(userId);
  if (!user) throw new Error('User not found');
  if (!user.mfaEnabled) return { mfaEnabled: false };

  if (!totp.verify(code, user.mfaSecret)) {
    throw new Error('Invalid verification code');
  }

  user.mfaEnabled = false;
  user.mfaSecret = undefined;
  await user.save();
  return { mfaEnabled: false };
};

// Verify the second-step login: validate the challenge token, then the TOTP code.
const verifyLoginChallenge = async (mfaToken, code) => {
  let decoded;
  try {
    decoded = jwt.verify(mfaToken, publicKey.replace(/\\n/gm, '\n'), {
      issuer: TokenIssuer,
      algorithms: ['RS512'],
    });
  } catch {
    throw new Error('MFA session expired. Please log in again.');
  }

  const payload = decoded.payload || {};
  if (payload.purpose !== 'mfa') {
    throw new Error('Invalid MFA session');
  }

  const Model = getModel(payload.accountType);
  const user = await Model.findById(payload.id);
  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    throw new Error('MFA is not active for this account');
  }

  if (!totp.verify(code, user.mfaSecret)) {
    throw new Error('Invalid verification code');
  }

  return user;
};

module.exports = { beginEnrollment, confirmEnrollment, disable, verifyLoginChallenge };
