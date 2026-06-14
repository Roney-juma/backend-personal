const providerAuditLogService = require('../service/providerAuditLog.service');

// ─── Module / resource-type maps ───────────────────────────────────────────────

const SEGMENT_MODULE_MAP = {
    companies:     'Insurance Companies',
    plans:         'Subscription Plans',
    subscriptions: 'Company Subscriptions',
    invoices:      'Invoices',
    'api-keys':    'API Keys',
    support:       'Support Tickets',
    dashboard:     'Dashboard',
    'audit-logs':  'Audit Logs',
};

const SEGMENT_RESOURCE_TYPE_MAP = {
    companies:     'InsuranceCompany',
    plans:         'SubscriptionPlan',
    subscriptions: 'CompanySubscription',
    invoices:      'Invoice',
    'api-keys':    'ApiKey',
    support:       'SupportTicket',
};

const MODULE_SINGULAR = {
    'Insurance Companies':   'Insurance Company',
    'Subscription Plans':    'Subscription Plan',
    'Company Subscriptions': 'Company Subscription',
    'Invoices':              'Invoice',
    'API Keys':              'API Key',
    'Support Tickets':       'Support Ticket',
    'Dashboard':             'Dashboard',
    'Audit Logs':            'Audit Log',
};

// ─── Action derivation ─────────────────────────────────────────────────────────

const METHOD_ACTION_MAP = {
    GET:    'READ',
    POST:   'CREATE',
    PATCH:  'UPDATE',
    PUT:    'UPDATE',
    DELETE: 'DELETE',
};

// Last URL segment → specific action name
const SUB_ACTION_MAP = {
    login:           'LOGIN',
    'reset-password':'RESET_PASSWORD',
    status:          'UPDATE_STATUS',
    stats:           'READ_STATS',
    revenue:         'READ_STATS',
    overview:        'READ_OVERVIEW',
    activity:        'READ_ACTIVITY',
    message:         'ADD_MESSAGE',
    assign:          'ASSIGN',
    resolve:         'RESOLVE',
    close:           'CLOSE',
    cancel:          'CANCEL',
    renew:           'RENEW',
    revoke:          'REVOKE',
    sent:            'MARK_SENT',
    paid:            'MARK_PAID',
    toggle:          'TOGGLE_STATUS',
    verify:          'VERIFY',
    export:          'EXPORT',
    purge:           'PURGE',
};

const DESCRIPTION_MAP = {
    READ:                    (m) => `Listed ${m}`,
    CREATE:                  (m, s) => `Created new ${s}`,
    UPDATE:                  (m, s) => `Updated ${s}`,
    DELETE:                  (m, s) => `Deleted ${s}`,
    LOGIN:                   (m, s) => `Authenticated via ${m}`,
    RESET_PASSWORD:          (m, s) => `Reset ${s} password`,
    UPDATE_STATUS:           (m, s) => `Changed ${s} status`,
    READ_STATS:              (m) => `Viewed ${m} statistics`,
    READ_OVERVIEW:           () => 'Viewed dashboard overview',
    READ_ACTIVITY:           () => 'Viewed recent activity',
    ADD_MESSAGE:             (m, s) => `Added message to ${s}`,
    ASSIGN:                  (m, s) => `Assigned ${s}`,
    RESOLVE:                 (m, s) => `Resolved ${s}`,
    CLOSE:                   (m, s) => `Closed ${s}`,
    CANCEL:                  (m, s) => `Cancelled ${s}`,
    RENEW:                   (m, s) => `Renewed ${s}`,
    REVOKE:                  (m, s) => `Revoked ${s}`,
    MARK_SENT:               (m, s) => `Marked ${s} as sent`,
    MARK_PAID:               (m, s) => `Marked ${s} as paid`,
    TOGGLE_STATUS:           (m, s) => `Toggled ${s} status`,
    VERIFY:                  (m, s) => `Verified ${s}`,
    EXPORT:                  (m) => `Exported ${m}`,
    PURGE:                   (m) => `Purged old ${m}`,
};

// ─── Classification ────────────────────────────────────────────────────────────

const CRITICAL_ACTIONS = new Set([
    'DELETE', 'REVOKE', 'RESET_PASSWORD', 'UPDATE_STATUS', 'CANCEL', 'PURGE',
]);

const READ_ACTIONS = new Set([
    'READ', 'READ_STATS', 'READ_OVERVIEW', 'READ_ACTIVITY',
]);

function deriveSeverity(action, statusCode) {
    if (statusCode >= 400) return 'warning';
    if (CRITICAL_ACTIONS.has(action)) return 'critical';
    if (READ_ACTIONS.has(action)) return 'info';
    return 'warning'; // all other mutations
}

function deriveCategory(action) {
    if (['LOGIN', 'RESET_PASSWORD'].includes(action)) return 'auth';
    if (READ_ACTIONS.has(action)) return 'data_access';
    if (['REVOKE', 'VERIFY', 'TOGGLE_STATUS', 'PURGE', 'EXPORT'].includes(action)) return 'system';
    return 'data_mutation';
}

// ─── Sensitive-field sanitiser ─────────────────────────────────────────────────

const SENSITIVE_FIELDS = new Set([
    'password', 'newPassword', 'oldPassword', 'confirmPassword',
    'keyHash', 'rawKey', 'secret', 'token', 'accessToken', 'refreshToken',
    'privateKey', 'apiKey',
]);

function sanitizeBody(body) {
    if (!body || typeof body !== 'object') return body;
    const out = Array.isArray(body) ? [] : {};
    for (const key of Object.keys(body)) {
        out[key] = SENSITIVE_FIELDS.has(key)
            ? '[REDACTED]'
            : sanitizeBody(body[key]);
    }
    return out;
}

// ─── URL parser ────────────────────────────────────────────────────────────────

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

function parseUrl(originalUrl) {
    const pathOnly = originalUrl.split('?')[0];
    const parts = pathOnly.split('/').filter(Boolean);

    // Strip the 'provider' prefix if present
    const providerIdx = parts.indexOf('provider');
    const moduleParts = providerIdx >= 0 ? parts.slice(providerIdx + 1) : parts;

    const moduleSegment = moduleParts[0] || '';
    const module = SEGMENT_MODULE_MAP[moduleSegment] || moduleSegment;
    const resourceType = SEGMENT_RESOURCE_TYPE_MAP[moduleSegment] || null;

    // First ObjectId-like segment after the module segment is the resource ID
    const resourceId = moduleParts.slice(1).find(p => OBJECT_ID_RE.test(p)) || null;

    // Last non-ObjectId, non-module segment drives the sub-action override
    const lastSegment = [...moduleParts]
        .reverse()
        .find(p => !OBJECT_ID_RE.test(p) && p !== moduleSegment) || null;

    return { module, moduleSegment, resourceType, resourceId, lastSegment };
}

// ─── Middleware ────────────────────────────────────────────────────────────────

const providerAuditLogger = (req, res, next) => {
    const startTime = Date.now();

    // Intercept res.json so we can read the response body in the 'finish' handler
    const originalJson = res.json.bind(res);
    let responseBody;
    res.json = (body) => {
        responseBody = body;
        return originalJson(body);
    };

    res.on('finish', async () => {
        try {
            const { module, resourceType, resourceId, lastSegment } = parseUrl(req.originalUrl);

            const action = (lastSegment && SUB_ACTION_MAP[lastSegment])
                ? SUB_ACTION_MAP[lastSegment]
                : (METHOD_ACTION_MAP[req.method] || req.method);

            const singular = MODULE_SINGULAR[module] || module;
            const descFn = DESCRIPTION_MAP[action];
            const actionDescription = descFn
                ? descFn(module, singular)
                : `${action} on ${module}`;

            const statusCode = res.statusCode;
            const success = statusCode < 400;
            const errorMessage = !success && responseBody?.message ? responseBody.message : null;

            const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || null;

            await providerAuditLogService.createLog({
                performedBy:      req.user?.id   || null,
                performedByName:  req.user?.fullName || req.user?.username || 'Unauthenticated',
                performedByEmail: req.user?.email || null,
                performedByRole:  req.user?.role  || null,

                action,
                actionDescription,
                module,
                resourceType,
                resourceId: resourceId && OBJECT_ID_RE.test(resourceId) ? resourceId : null,

                method:      req.method,
                endpoint:    req.originalUrl,
                requestBody: req.body && Object.keys(req.body).length ? sanitizeBody(req.body) : null,
                queryParams: req.query && Object.keys(req.query).length ? req.query : null,

                ipAddress:  rawIp,
                userAgent:  req.headers['user-agent'] || null,
                requestId:  req.headers['x-request-id'] || null,

                statusCode,
                success,
                errorMessage,
                responseTimeMs: Date.now() - startTime,

                severity: deriveSeverity(action, statusCode),
                category: deriveCategory(action),
            });
        } catch (_) {
            // Audit logging must never crash the main request
        }
    });

    next();
};

module.exports = providerAuditLogger;
