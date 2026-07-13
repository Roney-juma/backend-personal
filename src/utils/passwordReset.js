const crypto = require('crypto');
const bcrypt = require('bcrypt');

// Password-reset tokens are valid for one hour and are single-use.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Create a password-reset token. The raw token is emailed to the user; only its
 * bcrypt hash is persisted, so a database read cannot be used to reset accounts.
 */
const createResetToken = async () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = await bcrypt.hash(rawToken, 10);
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  return { rawToken, hashedToken, expires };
};

/**
 * Verify a presented raw token against the stored hash and expiry.
 * Returns false for any missing, mismatched, or expired token.
 */
const verifyResetToken = async (rawToken, user) => {
  if (!rawToken || !user || !user.resetPasswordToken || !user.resetPasswordExpires) {
    return false;
  }
  const expiresAt = new Date(user.resetPasswordExpires).getTime();
  if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
    return false;
  }
  return bcrypt.compare(rawToken, user.resetPasswordToken);
};

/**
 * Build the reset link sent to users. Base URL is configurable per environment.
 */
const buildResetUrl = (rawToken, email) => {
  const base = process.env.PASSWORD_RESET_URL || 'https://app.aveafrica.com/reset-password';
  const params = new URLSearchParams({ token: rawToken, email });
  return `${base}?${params.toString()}`;
};

module.exports = { createResetToken, verifyResetToken, buildResetUrl, RESET_TOKEN_TTL_MS };
