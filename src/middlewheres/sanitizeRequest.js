// WAF-lite input sanitizer. Strips keys that enable the two most common attacks against
// a Mongoose/Express app coming from untrusted JSON:
//   1. NoSQL operator injection — keys starting with "$" or containing "." (e.g. { "$gt": "" },
//      { "price.$ne": 1 }) which Mongoose would interpret as query operators / dotted paths.
//   2. Prototype pollution — "__proto__" / "constructor" / "prototype" keys.
// Offending keys are removed (not rejected) and logged, so a hostile field can't reach the DB layer.
const logger = require('./logger');

const FORBIDDEN_KEY = /^\$|\./;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 12; // guard against pathologically nested payloads

const sanitize = (obj, pathPrefix, report, depth = 0) => {
  if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) return;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEY.test(key) || PROTO_KEYS.has(key)) {
      report.push(`${pathPrefix}${key}`);
      delete obj[key];
      continue;
    }
    const value = obj[key];
    if (value && typeof value === 'object') {
      sanitize(value, `${pathPrefix}${key}.`, report, depth + 1);
    }
  }
};

module.exports = (req, res, next) => {
  const report = [];
  // req.query/req.params are plain objects in Express 4 and safe to mutate in place.
  sanitize(req.body, 'body.', report);
  sanitize(req.query, 'query.', report);
  sanitize(req.params, 'params.', report);

  if (report.length) {
    logger.warn(`[waf] stripped suspicious keys from ${req.method} ${req.originalUrl} | ${report.join(', ')}`);
  }
  next();
};
