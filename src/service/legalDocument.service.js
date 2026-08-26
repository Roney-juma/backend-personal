const crypto = require('crypto');
const path = require('path');
const AWS = require('aws-sdk');
const LegalDocument = require('../models/legalDocument.model');
const { LegalDocumentAccess } = require('../models/legalDocument.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const legalConfig = require('./legalConfig.service');
const { CONFIDENTIALITY, LEGAL_DOC_TYPES } = require('../constants/legal.constants');

/**
 * Legal documents: privilege, versioning and access logging.
 *
 * This is the one place in AVICS where the platform's usual "upload returns an
 * S3 URL" pattern is not good enough. Counsel's opinion on our own liability
 * behind a guessable link is a disclosure incident, and in a third-party matter
 * the opposing side has every incentive to get hold of it.
 *
 * So documents are stored by KEY, never by URL, and the only way to read one is
 * through requestAccess(), which checks the privilege class, mints a short-lived
 * signed link, and writes an access row. Spec §22's download history only means
 * anything if the API is the only door.
 */

const s3Client = () => {
  AWS.config.update({
    accessKeyId: process.env.SECRET_ID_AWS,
    secretAccessKey: process.env.SECRET_KEY_AWS,
    region: process.env.AWS_REGION,
  });
  return new AWS.S3({ signatureVersion: 'v4' });
};

const BUCKET = () => process.env.BUCKET_NAME;

/**
 * Who may see what.
 *
 * Ordered from most to least restrictive. `privileged` needs its own permission
 * — deliberately NOT implied by VIEW_LEGAL_DOCUMENTS, because a broad
 * read-everything role (Auditor especially) must not inherit legal advice by
 * accident.
 */
function canView(document, actor, { config, isAdvocate = false }) {
  const confidentiality = document.confidentiality || CONFIDENTIALITY.INTERNAL;
  const permissions = (actor?.permissions || []).map((p) => String(p).toUpperCase());
  const roleName = String(actor?.roleName || '').toLowerCase().replace(/[\s_-]/g, '');
  const isAdmin = roleName === 'admin' || roleName === 'superadmin';

  // The advocate portal sees only what was explicitly shared with it or already
  // filed in open court. Never our internal notes, never our own privileged
  // assessment of the case — regardless of assignment.
  if (isAdvocate) {
    const allowed = [CONFIDENTIALITY.ADVOCATE_SHARED, CONFIDENTIALITY.COURT_FILED];
    return allowed.includes(confidentiality)
      ? { allowed: true }
      : { allowed: false, reason: 'That document has not been shared with counsel' };
  }

  if (confidentiality === CONFIDENTIALITY.PRIVILEGED) {
    if (isAdmin) return { allowed: true };
    if (permissions.includes('VIEW_PRIVILEGED_DOCUMENTS')) return { allowed: true };

    // Auditors are the interesting case: spec §21 gives them read-everything,
    // §22 requires document-level permissions, and those conflict on legal
    // advice. The tenant resolves it — default is metadata and access log, but
    // not the contents.
    const isAuditor = roleName === 'auditor';
    if (isAuditor && config?.auditorSeesPrivilegedContents) return { allowed: true };

    return {
      allowed: false,
      reason: isAuditor
        ? 'Privileged contents are withheld from audit access for this insurer. ' +
          'The document metadata and its full access log are available.'
        : 'This document is legally privileged and requires VIEW_PRIVILEGED_DOCUMENTS',
    };
  }

  if (isAdmin || permissions.includes('VIEW_LEGAL_DOCUMENTS')) return { allowed: true };
  return { allowed: false, reason: 'Requires VIEW_LEGAL_DOCUMENTS' };
}

/**
 * Store an uploaded file and record it.
 *
 * @param {Object} params
 * @param {Object} params.file        multer file (memory storage)
 * @param {Object} params.meta        docType, title, confidentiality, links
 * @param {Object} [actor]
 */
async function upload({ file, meta }, actor = null, { actorType = 'Users' } = {}) {
  if (!file) throw new ApiError(400, 'No file uploaded');
  if (!meta?.company) throw new ApiError(400, 'A legal document must be scoped to a company');
  if (!LEGAL_DOC_TYPES.includes(meta.docType)) {
    throw new ApiError(400, `Unknown legal document type: ${meta.docType}`);
  }
  if (!meta.legalCase && !meta.thirdPartyClaim && !meta.claim) {
    throw new ApiError(400, 'A legal document must attach to a case, a third-party claim, or a claim');
  }

  // An advocate can only ever contribute documents counsel is meant to share.
  const confidentiality =
    actorType === 'Advocate'
      ? CONFIDENTIALITY.ADVOCATE_SHARED
      : meta.confidentiality || CONFIDENTIALITY.INTERNAL;

  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // Keyed, not public. The prefix keeps legal material separate from claim
  // photos in the bucket, which matters for lifecycle and access policies.
  const key = `legal/${meta.company}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${file.originalname}`;

  await s3Client()
    .putObject({
      Bucket: BUCKET(),
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // Defence in depth: even if a link leaked, the object is not public.
      ServerSideEncryption: 'AES256',
      Metadata: { company: String(meta.company), confidentiality },
    })
    .promise();

  // Versioning: a new version supersedes the current one, which is retained.
  // Destroying an earlier draft of a pleading during live litigation is its own
  // problem, so nothing is deleted.
  let version = 1;
  let supersedes;
  if (meta.supersedes) {
    const prior = await LegalDocument.findById(meta.supersedes);
    if (!prior) throw new ApiError(404, 'The document being superseded was not found');
    version = (prior.version || 1) + 1;
    supersedes = prior._id;
    prior.isCurrent = false;
    await prior.save();
  }

  const document = await LegalDocument.create({
    company: meta.company,
    claim: meta.claim,
    legalCase: meta.legalCase,
    thirdPartyClaim: meta.thirdPartyClaim,
    docType: meta.docType,
    title: meta.title || file.originalname,
    description: meta.description,
    storageKey: key,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    checksum,
    version,
    supersedes,
    isCurrent: true,
    confidentiality,
    uploadedByType: actorType,
    uploadedBy: actor?._id || actor?.id || null,
    uploadedByName: actor?.fullName || actor?.name || 'System',
    sourceSystem: meta.sourceSystem,
  });

  logger.info(
    `[legal-doc] ${document.docType} "${document.title}" v${version} uploaded ` +
    `(${confidentiality}) by ${document.uploadedByName}`
  );
  return document;
}

/**
 * Resolve a document to a short-lived signed link, enforcing privilege and
 * logging the attempt.
 *
 * A DENIED attempt is logged too — someone trying to open privileged advice
 * without the permission is exactly the event an auditor wants to see, and it is
 * invisible if only successes are recorded.
 */
async function requestAccess(documentId, actor, { req = null, isAdvocate = false, action = 'download' } = {}) {
  const document = await LegalDocument.findById(documentId);
  if (!document) throw new ApiError(404, 'Document not found');

  const config = await legalConfig.get(document.company);
  const { allowed, reason } = canView(document, actor, { config, isAdvocate });

  await logAccess(document, actor, {
    action: allowed ? action : 'denied',
    denialReason: allowed ? undefined : reason,
    req,
    actorType: isAdvocate ? 'Advocate' : 'Users',
  });

  if (!allowed) throw new ApiError(403, reason);

  const expiresIn = config.documentLinkTtlSeconds || 300;
  const { name, ascii } = downloadFilename(document);

  const url = await s3Client().getSignedUrlPromise('getObject', {
    Bucket: BUCKET(),
    Key: document.storageKey,
    Expires: expiresIn,
    // Saved under the human title, but with the real extension — see
    // downloadFilename. Both forms are sent: the quoted one for older clients,
    // filename* for anything with characters Latin-1 cannot carry.
    ResponseContentDisposition:
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    // Without this S3 serves whatever it stored the object as, which for an
    // upload that arrived with no type is application/octet-stream — another
    // way to end up with a file nothing will open.
    ...(document.mimeType ? { ResponseContentType: document.mimeType } : {}),
  });

  return {
    url,
    expiresInSeconds: expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    document: {
      _id: document._id,
      title: document.title,
      docType: document.docType,
      confidentiality: document.confidentiality,
      version: document.version,
      checksum: document.checksum,
    },
  };
}

/**
 * Extensions for the types the legal file actually carries, so a document whose
 * key somehow lost its own can still be opened.
 */
const EXT_BY_MIME = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tif',
  'text/plain': '.txt',
};

/**
 * The name the file is saved under.
 *
 * Built from the human title, but the EXTENSION has to come from the file
 * itself: a document titled "Witness statement" saved with no `.pdf` is a file
 * the operating system cannot open, which reads to the user as a corrupt
 * download rather than a naming problem. The original extension lives on the
 * end of the storage key; the mime type is the fallback.
 *
 * Percent-encoding is NOT applied to the quoted form — doing so turns a space
 * into a literal "%20" in the saved name. Non-ASCII titles are carried by the
 * RFC 5987 `filename*` parameter instead, which is what that parameter is for.
 */
function downloadFilename(document) {
  const ext = path.extname(document.storageKey || '') || EXT_BY_MIME[document.mimeType] || '';

  const base = String(document.title || 'document')
    // Characters that are illegal in a filename, or would end the quoted string.
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'document';

  const name = base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`;

  // Latin-1 is all a quoted filename may legally contain; anything else is
  // dropped here and recovered from filename* by any modern browser.
  const ascii = name.replace(/[^\x20-\x7E]/g, '_');

  return { name, ascii };
}

/** Append-only record of every view, download and refusal. */
async function logAccess(document, actor, { action, denialReason, req, actorType = 'Users' }) {
  try {
    await LegalDocumentAccess.create({
      document: document._id,
      company: document.company,
      legalCase: document.legalCase,
      action,
      actorType,
      actor: actor?._id || actor?.id || null,
      actorName: actor?.fullName || actor?.name || 'Unknown',
      actorEmail: actor?.email,
      denialReason,
      confidentialityAtAccess: document.confidentiality,
      ipAddress: req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.ip,
      userAgent: req?.headers?.['user-agent'],
      at: new Date(),
    });
  } catch (err) {
    // Never fail the request because logging failed — but say so loudly, since
    // an unlogged access undermines the whole privilege story.
    logger.error(`[legal-doc] ACCESS LOG WRITE FAILED for ${document._id}: ${err.message}`);
  }
}

/**
 * List documents on a matter.
 *
 * Privileged documents are always LISTED — their existence is not the secret,
 * their contents are. Each row carries `canView` so the UI can show a locked
 * row with a reason rather than pretending the document is not there. That
 * distinction is what lets an auditor see the full file index while still being
 * kept out of the advice itself.
 */
async function list({ legalCase, thirdPartyClaim, claim, company, currentOnly = true }, actor, { isAdvocate = false } = {}) {
  const filter = { company };
  if (legalCase) filter.legalCase = legalCase;
  if (thirdPartyClaim) filter.thirdPartyClaim = thirdPartyClaim;
  if (claim) filter.claim = claim;
  if (currentOnly) filter.isCurrent = true;

  if (isAdvocate) {
    filter.confidentiality = { $in: [CONFIDENTIALITY.ADVOCATE_SHARED, CONFIDENTIALITY.COURT_FILED] };
  }

  const documents = await LegalDocument.find(filter).sort({ createdAt: -1 }).lean();
  const config = await legalConfig.get(company);

  return documents.map((d) => {
    const { allowed, reason } = canView(d, actor, { config, isAdvocate });
    return {
      ...d,
      // Never leak the key: it is the one thing that could be used to build a
      // link outside the API.
      storageKey: undefined,
      canView: allowed,
      blockedReason: allowed ? null : reason,
    };
  });
}

/**
 * The access history for one document — who opened it, when, and who was turned
 * away. This is the evidence that privilege was actually maintained.
 */
async function accessLog(documentId, { limit = 200 } = {}) {
  return LegalDocumentAccess.find({ document: documentId })
    .sort({ at: -1 })
    .limit(limit)
    .lean();
}

/**
 * Change a document's privilege class.
 *
 * Downgrading privilege is a disclosure decision, so it is deliberate, reasoned
 * and audited by the caller. Most commonly used when a privileged draft becomes
 * a filed pleading and privilege no longer attaches.
 */
async function reclassify(documentId, confidentiality, reason, actor = null) {
  if (!Object.values(CONFIDENTIALITY).includes(confidentiality)) {
    throw new ApiError(400, `Unknown confidentiality class: ${confidentiality}`);
  }
  if (!String(reason || '').trim()) {
    throw new ApiError(400, 'Changing a document\'s confidentiality requires a reason');
  }

  const document = await LegalDocument.findById(documentId);
  if (!document) throw new ApiError(404, 'Document not found');

  const previous = document.confidentiality;
  document.confidentiality = confidentiality;
  await document.save();

  await logAccess(document, actor, {
    action: 'share',
    denialReason: `Reclassified ${previous} → ${confidentiality}: ${reason}`,
  });

  logger.info(
    `[legal-doc] ${document._id} reclassified ${previous} → ${confidentiality} by ` +
    `${actor?.fullName || 'system'}: ${reason}`
  );
  return document;
}

/** Mark a document as filed in court. Filing removes any privilege claim. */
async function markFiled(documentId, { filedAt, courtReference }, actor = null) {
  const document = await LegalDocument.findById(documentId);
  if (!document) throw new ApiError(404, 'Document not found');

  document.filedAt = filedAt ? new Date(filedAt) : new Date();
  document.filedBy = actor?._id || actor?.id || null;
  document.courtStamped = true;
  document.courtReference = courtReference;
  // Once it is on the court file it is public; carrying it as privileged would
  // be a false restriction that hides it from people who need it.
  if (document.confidentiality === CONFIDENTIALITY.PRIVILEGED) {
    document.confidentiality = CONFIDENTIALITY.COURT_FILED;
  }
  await document.save();
  return document;
}

module.exports = {
  upload,
  requestAccess,
  list,
  accessLog,
  reclassify,
  markFiled,
  canView,
  // Exported for the checks in scripts/test-legal-litigation.js: a download
  // named without its extension is indistinguishable from a corrupt file.
  downloadFilename,
};
