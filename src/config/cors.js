// Restricted CORS — shared by the Express app and Socket.IO.
// Set CORS_ORIGINS to a comma-separated allowlist of browser origins, e.g.
//   CORS_ORIGINS=https://app.aveafrica.com,https://admin.aveafrica.com,http://localhost:3000
// If unset, only localhost dev origins are allowed (secure by default — add prod domains before deploying).
const logger = require('../middlewheres/logger');

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
];

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const effectiveOrigins = allowedOrigins.length ? allowedOrigins : DEFAULT_DEV_ORIGINS;

if (!allowedOrigins.length) {
  logger.warn(`[cors] CORS_ORIGINS not set — allowing dev origins only: ${DEFAULT_DEV_ORIGINS.join(', ')}`);
}

// Requests with no Origin header (curl, mobile apps, server-to-server) are allowed;
// browsers always send Origin, so this only affects non-browser callers.
const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (effectiveOrigins.includes('*')) return true;
  return effectiveOrigins.includes(origin);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    logger.warn(`[cors] blocked origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

module.exports = { corsOptions, isAllowedOrigin, effectiveOrigins };
