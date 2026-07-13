// Account lockout after repeated failed logins. Complements the per-IP auth
// rate limiter by binding the throttle to the account itself, so an attacker
// rotating IPs still triggers a lockout. Works on any mongoose user document
// that has `failedLoginAttempts` (Number) and `lockUntil` (Date) fields.

const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS) || 15 * 60 * 1000;

const isLocked = (user) =>
  Boolean(user && user.lockUntil && new Date(user.lockUntil).getTime() > Date.now());

// Minutes remaining on an active lock, rounded up (for user-facing messages).
const lockMinutesRemaining = (user) => {
  if (!isLocked(user)) return 0;
  return Math.ceil((new Date(user.lockUntil).getTime() - Date.now()) / 60000);
};

// Record a failed attempt; lock the account once MAX_ATTEMPTS is reached.
const registerFailedAttempt = async (user) => {
  if (!user) return;
  const now = Date.now();
  // If a previous lock has expired, start the count fresh.
  let attempts =
    user.lockUntil && new Date(user.lockUntil).getTime() <= now
      ? 0
      : user.failedLoginAttempts || 0;

  attempts += 1;
  user.failedLoginAttempts = attempts;
  if (attempts >= MAX_ATTEMPTS) {
    user.lockUntil = new Date(now + LOCK_MS);
  }
  await user.save();
};

// Clear counters after a successful login.
const resetAttempts = async (user) => {
  if (!user) return;
  if (user.failedLoginAttempts || user.lockUntil) {
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();
  }
};

class AccountLockedError extends Error {
  constructor(user) {
    super(
      `Account temporarily locked due to too many failed attempts. Try again in ${lockMinutesRemaining(
        user
      )} minute(s).`
    );
    this.name = 'AccountLockedError';
    this.code = 'ACCOUNT_LOCKED';
  }
}

module.exports = {
  isLocked,
  lockMinutesRemaining,
  registerFailedAttempt,
  resetAttempts,
  AccountLockedError,
  MAX_ATTEMPTS,
  LOCK_MS,
};
