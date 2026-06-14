const AuditLog = require('../models/audit.model');

const SENSITIVE_FIELDS = new Set(['password', 'newPassword', 'currentPassword', 'token', 'secret', 'apiKey', 'refreshToken']);

function sanitizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const sanitized = { ...body };
  for (const field of SENSITIVE_FIELDS) {
    if (field in sanitized) sanitized[field] = '[REDACTED]';
  }
  return sanitized;
}

function getIpAddress(req) {
  if (!req) return null;
  const forwarded = req.headers?.['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0].trim() : null)
    || req.ip
    || req.connection?.remoteAddress
    || null;
}

function deriveSeverity(action) {
  if (['LOGIN', 'LOGOUT', 'REVOKE', 'RESET_PASSWORD'].includes(action)) return 'critical';
  if (action === 'DELETE') return 'warning';
  return 'info';
}

function deriveCategory(action) {
  if (['LOGIN', 'LOGOUT', 'REVOKE', 'RESET_PASSWORD'].includes(action)) return 'auth';
  if (['CREATE', 'UPDATE', 'DELETE'].includes(action)) return 'data_mutation';
  if (action === 'READ') return 'data_access';
  return 'system';
}

/**
 * Write a structured audit log entry from an Express request.
 * Never throws — a logging failure must not crash the application.
 *
 * @param {import('express').Request|null} req   - Express request (null for system-automated actions)
 * @param {Object}  opts
 * @param {string}  opts.action                  - CREATE | UPDATE | DELETE | LOGIN | RESET_PASSWORD | …
 * @param {string}  opts.module                  - Domain module ("Assessor", "Claim", "Auth", …)
 * @param {string}  [opts.actionDescription]     - Human-readable summary
 * @param {string}  [opts.resourceType]          - Mongoose model name (defaults to opts.module)
 * @param {*}       [opts.resourceId]            - _id of the affected document
 * @param {number}  [opts.statusCode=200]        - HTTP status code of the response
 * @param {boolean} [opts.success=true]
 * @param {string}  [opts.errorMessage]
 * @param {number}  [opts.responseTimeMs]
 * @param {Object}  [opts.changes]               - { old, new }
 */
async function writeAuditLog(req, opts) {
  try {
    const {
      action,
      module,
      actionDescription = null,
      resourceType,
      resourceId = null,
      statusCode = 200,
      success = true,
      errorMessage = null,
      responseTimeMs = null,
      changes = null,
    } = opts;

    const user = req?.user ?? null;

    const performedByName =
      user?.name ??
      user?.fullName ??
      (user?.firstName || user?.lastName
        ? `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
        : null) ??
      (user?.first_name || user?.last_name
        ? `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim()
        : null) ??
      'System';

    await AuditLog.create({
      // Actor
      performedBy:      user?._id ?? user?.id ?? null,
      performedByName,
      performedByEmail: user?.email ?? null,
      performedByRole:  user?.role_ID ?? null,

      // Action metadata
      action,
      actionDescription,
      module,
      resourceType: resourceType ?? module,
      resourceId,

      // HTTP context
      method:      req?.method ?? 'SYSTEM',
      endpoint:    req?.originalUrl ?? req?.path ?? 'internal',
      requestBody: sanitizeBody(req?.body) ?? null,
      queryParams: req?.query && Object.keys(req.query).length ? req.query : null,

      // Network / client
      ipAddress:  getIpAddress(req),
      userAgent:  req?.headers?.['user-agent'] ?? null,
      requestId:  req?.headers?.['x-request-id'] ?? null,

      // Response outcome
      statusCode,
      success,
      errorMessage,
      responseTimeMs,

      // Classification (auto-derived)
      severity: deriveSeverity(action),
      category: deriveCategory(action),

      // Change tracking
      changes,
    });
  } catch (err) {
    console.error('[Audit] Failed to write log entry:', err.message);
  }
}

module.exports = { writeAuditLog };
