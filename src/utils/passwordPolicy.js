// Single source of truth for password strength, enforced server-side on every
// endpoint that sets a password (register, admin-create, reset, change).
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

const RULES = [
  { test: (p) => p.length >= PASSWORD_MIN_LENGTH, label: `at least ${PASSWORD_MIN_LENGTH} characters` },
  { test: (p) => /[A-Z]/.test(p), label: 'an uppercase letter' },
  { test: (p) => /[a-z]/.test(p), label: 'a lowercase letter' },
  { test: (p) => /[0-9]/.test(p), label: 'a number' },
];

/**
 * @returns {{ valid: boolean, message: string }}
 */
const validatePassword = (password) => {
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, message: 'Password is required' };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { valid: false, message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters` };
  }
  const missing = RULES.filter((r) => !r.test(password)).map((r) => r.label);
  if (missing.length) {
    return { valid: false, message: `Password must contain ${missing.join(', ')}` };
  }
  return { valid: true, message: '' };
};

// Throws an Error tagged with statusCode 400 so controllers can return the
// right status (most already surface error.message).
const assertValidPassword = (password) => {
  const { valid, message } = validatePassword(password);
  if (!valid) {
    const err = new Error(message);
    err.statusCode = 400;
    err.code = 'INVALID_PASSWORD';
    throw err;
  }
};

module.exports = { validatePassword, assertValidPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH };
