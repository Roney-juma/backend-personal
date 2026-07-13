const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { makeRedisStore } = require('./rateLimitStore');

// Strict limiter for authentication endpoints (login, forgot/reset password).
// Keyed by client IP + submitted email so both distributed and targeted
// brute-force attempts are throttled. Tunable via env; defaults to 10 / 15 min.
const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Redis store => the auth limit is shared across all instances (brute-force
  // protection can't be diluted by spreading attempts over multiple servers).
  store: makeRedisStore('rl:auth:'),
  // Do not count successful logins against the limit — only failed/abusive attempts.
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = (req.body && req.body.email ? String(req.body.email) : '').toLowerCase();
    // ipKeyGenerator normalizes IPv6 addresses to a subnet so they can't be rotated to bypass limits.
    return `${ipKeyGenerator(req.ip)}:${email}`;
  },
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
});

module.exports = authLimiter;
