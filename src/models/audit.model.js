const mongoose = require('mongoose');
const appendOnly = require('./plugins/appendOnly');
const hashChain = require('./plugins/hashChain');

const auditLogSchema = new mongoose.Schema({
 // Who performed the action
        performedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
        performedByName:  { type: String, default: 'Unauthenticated' },
        performedByEmail: { type: String, default: null },
        performedByRole:  { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },

        // Tenant the actor belongs to (null = platform staff / system / unauthenticated)
        company:          { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', default: null },

        // What was done
        action:           { type: String, required: true },  // CREATE, READ, UPDATE, DELETE, LOGIN, REVOKE, etc.
        actionDescription:{ type: String },                  // human-readable: "Updated company status to suspended"
        module:           { type: String, required: true },  // Insurance Companies | Invoices | API Keys | …
        resourceType:     { type: String, default: null },   // Mongoose model name of the affected document
        resourceId:       { type: mongoose.Schema.Types.ObjectId, default: null }, // _id of the affected document

        // HTTP request context
        method:           { type: String, enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], required: true },
        endpoint:         { type: String, required: true },
        requestBody:      { type: mongoose.Schema.Types.Mixed, default: null }, // sensitive fields redacted
        queryParams:      { type: mongoose.Schema.Types.Mixed, default: null },

        // Network / client context
        ipAddress:        { type: String, default: null },
        userAgent:        { type: String, default: null },
        requestId:        { type: String, default: null },   // optional correlation ID from X-Request-Id header

        // Response outcome
        statusCode:       { type: Number, required: true },
        success:          { type: Boolean, required: true },
        errorMessage:     { type: String, default: null },   // message from error response body
        responseTimeMs:   { type: Number, default: null },

        // Classification
        severity: {
            type: String,
            enum: ['info', 'warning', 'critical'],
            default: 'info',
        },
        category: {
            type: String,
            enum: ['auth', 'data_access', 'data_mutation', 'system'],
            default: 'data_access',
        },

        // Change tracking – populated by individual services when they record before/after state
        changes: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    { timestamps: true }
);

// Indexes optimised for the most common query patterns
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ company: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ module: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ severity: 1, createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ statusCode: 1, createdAt: -1 });
auditLogSchema.index({ resourceId: 1, createdAt: -1 });

// Tamper-evidence: every row is sequenced and content-hashed on insert, then
// covered by a periodic AuditSeal (see service/auditSeal.service.js). Spec §23
// requires the legal audit record to be immutable; appendOnly stops our own
// code from rewriting history, the hash chain makes any other route detectable.
auditLogSchema.plugin(hashChain, { chainKey: 'audit' });
auditLogSchema.plugin(appendOnly);

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;