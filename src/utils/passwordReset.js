const crypto = require('crypto');
const bcrypt = require('bcrypt');

// Reset codes are valid for one hour and are single-use.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Create a password-reset code. The users who reset passwords are all on the
 * mobile app, which asks them to type a code — so we issue a 6-digit numeric
 * code rather than a long URL token. Only the bcrypt hash is persisted, so a
 * database read cannot be used to reset accounts. Brute-force is bounded by the
 * per-IP+email auth rate limiter plus the one-hour, single-use expiry.
 */
const createResetToken = async () => {
  const rawToken = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  const hashedToken = await bcrypt.hash(rawToken, 10);
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  return { rawToken, hashedToken, expires };
};

/**
 * Verify a presented code against the stored hash and expiry.
 * Returns false for any missing, mismatched, or expired code.
 */
const verifyResetToken = async (rawToken, user) => {
  if (!rawToken || !user || !user.resetPasswordToken || !user.resetPasswordExpires) {
    return false;
  }
  const expiresAt = new Date(user.resetPasswordExpires).getTime();
  if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
    return false;
  }
  return bcrypt.compare(String(rawToken).trim(), user.resetPasswordToken);
};

/**
 * Standard reset-code email body. Presents the code to type into the app.
 */
const resetEmailBody = (name, code) =>
  `Dear ${name || 'there'},\n\n` +
  `Your Ave Insurance password reset code is:\n\n` +
  `    ${code}\n\n` +
  `Enter this code in the app within one hour to set a new password.\n\n` +
  `If you did not request this, you can safely ignore this email.`;

module.exports = { createResetToken, verifyResetToken, resetEmailBody, RESET_TOKEN_TTL_MS };
