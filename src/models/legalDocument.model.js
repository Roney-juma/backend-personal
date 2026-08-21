const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const appendOnly = require('./plugins/appendOnly');
const { CONFIDENTIALITY, LEGAL_DOC_TYPES } = require('../constants/legal.constants');

const { Schema } = mongoose;

/**
 * A document in the legal file, with a privilege class, a version chain and an
 * access log.
 *
 * Privilege is the one place where the platform's usual "upload returns an S3
 * URL" pattern is genuinely unsafe. Counsel's opinion on our own liability
 * behind a guessable link is a disclosure incident, and in a third-party matter
 * the opposing side has every incentive to obtain it.
 *
 * So: downloads are served through the API as short-lived signed URLs, never as
 * stored public links, and every access writes a LegalDocumentAccess row. Spec
 * §22's download history and document access history only hold if the API is the
 * only way in — which is why `storageKey` is a bucket key, not a URL.
 */
const legalDocumentSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', index: true },
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },
    // Demand letters and medical reports attach to an exposure long before any suit.
    thirdPartyClaim: { type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim', index: true },

    docType: { type: String, enum: LEGAL_DOC_TYPES, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String },

    // Bucket key, NOT a URL. Resolving it to a signed link is the API's job, so
    // that every resolution can be permission-checked and logged.
    storageKey: { type: String, required: true },
    mimeType: { type: String },
    sizeBytes: { type: Number },
    // sha256 of the uploaded bytes — proves the file served is the file filed.
    checksum: { type: String },

    // ── Version chain ────────────────────────────────────────────────────────
    // A superseded version is never deleted: an earlier draft of a pleading can
    // matter later, and destroying it during live litigation is its own problem.
    version: { type: Number, default: 1 },
    supersedes: { type: Schema.Types.ObjectId, ref: 'LegalDocument' },
    isCurrent: { type: Boolean, default: true, index: true },

    /**
     * Who may see the contents.
     *   privileged      — requires VIEW_PRIVILEGED_DOCUMENTS; never leaves the portal
     *   internal        — staff with VIEW_LEGAL_DOCUMENTS
     *   advocate_shared — additionally visible to the appointed panel advocate
     *   court_filed     — filed publicly; no privilege attaches
     */
    confidentiality: {
      type: String,
      enum: Object.values(CONFIDENTIALITY),
      default: CONFIDENTIALITY.INTERNAL,
      required: true,
      index: true,
    },

    uploadedByType: { type: String, enum: ['Users', 'Advocate', 'system'], default: 'Users' },
    uploadedBy: { type: Schema.Types.ObjectId },
    uploadedByName: { type: String },
    uploadedAt: { type: Date, default: Date.now },

    // ── Court filing ─────────────────────────────────────────────────────────
    filedAt: { type: Date },
    filedBy: { type: Schema.Types.ObjectId },
    courtStamped: { type: Boolean, default: false },
    courtReference: { type: String },

    // Where the file came from, for the policy document pulled out of the core
    // system into the legal pack.
    sourceSystem: { type: String },

    retainUntil: { type: Date },
  },
  { timestamps: true }
);

// The case file view: current documents by type.
legalDocumentSchema.index({ legalCase: 1, isCurrent: 1, docType: 1 });
legalDocumentSchema.index({ thirdPartyClaim: 1, isCurrent: 1 });
// Version-chain walks.
legalDocumentSchema.index({ supersedes: 1 });

legalDocumentSchema.plugin(softDelete);

const LegalDocument = mongoose.model('LegalDocument', legalDocumentSchema);

/**
 * Append-only record of every view, download and share of a legal document.
 *
 * Required by spec §22 (download history, document access history) and, more
 * practically, this is the evidence that privilege was maintained — you cannot
 * demonstrate a document was properly restricted without a record of who opened
 * it. Nothing here is ever edited or deleted.
 */
const legalDocumentAccessSchema = new Schema(
  {
    document: { type: Schema.Types.ObjectId, ref: 'LegalDocument', required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase' },

    action: {
      type: String,
      enum: ['view', 'download', 'share', 'print', 'denied'],
      required: true,
    },

    actorType: { type: String, enum: ['Users', 'Advocate', 'system'], required: true },
    actor: { type: Schema.Types.ObjectId },
    actorName: { type: String },
    actorEmail: { type: String },

    // Populated on 'denied' — an attempt to open a privileged document without
    // the permission is exactly the event an auditor wants to see.
    denialReason: { type: String },

    confidentialityAtAccess: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    at: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

legalDocumentAccessSchema.index({ document: 1, at: -1 });
legalDocumentAccessSchema.index({ company: 1, at: -1 });
legalDocumentAccessSchema.index({ actor: 1, at: -1 });

legalDocumentAccessSchema.plugin(appendOnly);

const LegalDocumentAccess = mongoose.model('LegalDocumentAccess', legalDocumentAccessSchema);

module.exports = LegalDocument;
module.exports.LegalDocument = LegalDocument;
module.exports.LegalDocumentAccess = LegalDocumentAccess;
