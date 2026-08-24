const legalCaseService = require('../service/legalCase.service');
const advocateService = require('../service/advocate.service');
const diaryService = require('../service/legalDiary.service');
const documentService = require('../service/legalDocument.service');
const LegalCase = require('../models/legalCase.model');
const Advocate = require('../models/advocate.model');
const LegalDocument = require('../models/legalDocument.model');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');
const ApiError = require('../utils/ApiError');
const money = require('../utils/money');

/**
 * Litigation, advocates, the court diary and legal documents.
 *
 * Tenant scope comes from the token throughout. Document reads go through the
 * service's privilege check — this layer never resolves a storage key itself.
 */

const handle = (res, error) => res.status(error.statusCode || 400).json({ message: error.message });

async function scopedCase(req) {
  const company = await getRequesterCompany(req);
  const legalCase = await LegalCase.findById(req.params.id).select('company caseNumber status claim');
  if (!legalCase) throw new ApiError(404, 'Legal case not found');
  if (!belongsToCompany(legalCase.company, company)) throw new ApiError(404, 'Legal case not found');
  return { legalCase, company };
}

// ── Cases ────────────────────────────────────────────────────────────────────

const listCases = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalCaseService.list({ ...req.query, company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCase = async (req, res) => {
  try {
    await scopedCase(req);
    res.status(200).json(await legalCaseService.getById(req.params.id, req.user));
  } catch (error) {
    handle(res, error);
  }
};

const createCase = async (req, res) => {
  try {
    const legalCase = await legalCaseService.create(req.body, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Opened legal case ${legalCase.caseNumber} in ${legalCase.court || 'court'} ` +
        `covering ${legalCase.thirdPartyClaims.length} exposure(s)`,
      resourceType: 'LegalCase',
      resourceId: legalCase._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(legalCase);
  } catch (error) {
    handle(res, error);
  }
};

const appointAdvocate = async (req, res) => {
  try {
    await scopedCase(req);
    const { legalCase, advocate, reassignedFrom } = await legalCaseService.appointAdvocate(
      req.params.id,
      req.body,
      req.user
    );

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Appointed ${advocate.name} (${advocate.firm?.name}) to ${legalCase.caseNumber} ` +
        `via ${legalCase.allocationMode} allocation` +
        (reassignedFrom ? ' — reassigned' : ''),
      resourceType: 'LegalCase',
      resourceId: legalCase._id,
      statusCode: 200,
      success: true,
      changes: { old: { advocate: reassignedFrom }, new: { advocate: advocate._id } },
    });

    res.status(200).json(legalCase);
  } catch (error) {
    handle(res, error);
  }
};

/**
 * The instruction pack, assembled from records AVICS already holds.
 * Returned for review rather than sent — see the service note on why.
 */
const instructionPack = async (req, res) => {
  try {
    await scopedCase(req);
    res.status(200).json(await legalCaseService.buildInstructionPack(req.params.id, req.user));
  } catch (error) {
    handle(res, error);
  }
};

const issueInstructions = async (req, res) => {
  try {
    await scopedCase(req);
    const legalCase = await legalCaseService.issueInstructions(req.params.id, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Issued instructions to counsel on ${legalCase.caseNumber}`,
      resourceType: 'LegalCase',
      resourceId: legalCase._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(legalCase);
  } catch (error) {
    handle(res, error);
  }
};

const recordJudgment = async (req, res) => {
  try {
    await scopedCase(req);
    const legalCase = await legalCaseService.recordJudgment(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Judgment in ${legalCase.caseNumber}: ${legalCase.judgment.liabilityOutcome} — ` +
        `${money.formatMinor(legalCase.judgment.totalMinor)}`,
      resourceType: 'LegalCase',
      resourceId: legalCase._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(legalCase);
  } catch (error) {
    handle(res, error);
  }
};

const createAppeal = async (req, res) => {
  try {
    await scopedCase(req);
    const appeal = await legalCaseService.createAppeal(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription: `Opened appeal ${appeal.caseNumber} against ${req.params.id}`,
      resourceType: 'LegalCase',
      resourceId: appeal._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(appeal);
  } catch (error) {
    handle(res, error);
  }
};

const closeCase = async (req, res) => {
  try {
    await scopedCase(req);
    const legalCase = await legalCaseService.close(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Closed ${legalCase.caseNumber}` + (req.body.force ? ' (forced — checklist incomplete)' : ''),
      resourceType: 'LegalCase',
      resourceId: legalCase._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(legalCase);
  } catch (error) {
    handle(res, error);
  }
};

// ── Advocates ────────────────────────────────────────────────────────────────

const listAdvocates = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await advocateService.list({ ...req.query, company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAdvocate = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const advocate = await advocateService.getById(req.params.id);
    if (!belongsToCompany(advocate.company, company)) {
      return res.status(404).json({ message: 'Advocate not found' });
    }
    res.status(200).json(advocate);
  } catch (error) {
    handle(res, error);
  }
};

const createAdvocate = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    if (!company) return res.status(400).json({ message: 'Only insurer users manage an advocate panel' });

    const advocate = await advocateService.create({ ...req.body, company }, req.user);
    const credentialsSent = Boolean(advocate.active_account);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Added ${advocate.name} (${advocate.firm.name}) to the advocate panel` +
        (credentialsSent ? `; portal credentials emailed to ${advocate.email}` : ''),
      resourceType: 'Advocate',
      resourceId: advocate._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json({
      ...advocate.toJSON(),
      // So the panel screen can say what happened rather than leaving the user
      // to wonder whether the advocate now has access.
      credentialsSent,
    });
  } catch (error) {
    handle(res, error);
  }
};

const updateAdvocate = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const existing = await Advocate.findById(req.params.id).select('company');
    if (!existing || !belongsToCompany(existing.company, company)) {
      return res.status(404).json({ message: 'Advocate not found' });
    }
    const advocate = await advocateService.update(req.params.id, { ...req.body }, req.user);
    res.status(200).json(advocate);
  } catch (error) {
    handle(res, error);
  }
};

const setAdvocateApproval = async (req, res) => {
  try {
    const advocate = await advocateService.setApproval(req.params.id, req.body.approved, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `${req.body.approved ? 'Approved' : 'Unapproved'} ${advocate.name} for panel duty`,
      resourceType: 'Advocate',
      resourceId: advocate._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(advocate);
  } catch (error) {
    handle(res, error);
  }
};

const suspendAdvocate = async (req, res) => {
  try {
    const result = await advocateService.suspend(req.params.id, req.body.reason, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Suspended ${result.advocate.name} — ${req.body.reason} ` +
        `(${result.openMattersRemaining} open matters still assigned)`,
      resourceType: 'Advocate',
      resourceId: result.advocate._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(result);
  } catch (error) {
    handle(res, error);
  }
};

/**
 * Rank or randomly pick from the panel for a matter. Advisory — the appointer
 * still chooses, and may override.
 */
const suggestAdvocate = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(
      await advocateService.suggest({
        company,
        court: req.query.court,
        county: req.query.county,
        claimType: req.query.claimType,
        mode: req.query.mode,
      })
    );
  } catch (error) {
    handle(res, error);
  }
};

const recomputeAdvocatePerformance = async (req, res) => {
  try {
    const performance = await advocateService.recomputePerformance(req.params.id);
    res.status(200).json(performance);
  } catch (error) {
    handle(res, error);
  }
};

const issueAdvocateCredentials = async (req, res) => {
  try {
    const advocate = await advocateService.issueCredentials(req.params.id, req.body.password, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Issued portal access to ${advocate.name}`,
      resourceType: 'Advocate',
      resourceId: advocate._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json({ message: 'Portal access issued', advocate: advocate.toJSON() });
  } catch (error) {
    handle(res, error);
  }
};

// ── Diary ────────────────────────────────────────────────────────────────────

const getDiary = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await diaryService.diary({ ...req.query, company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCaseDiary = async (req, res) => {
  try {
    await scopedCase(req);
    res.status(200).json(await diaryService.caseDiary(req.params.id));
  } catch (error) {
    handle(res, error);
  }
};

const createEvent = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const event = await diaryService.createEvent({ ...req.body, company }, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription: `Diarised "${event.title}" for ${new Date(event.dueAt).toDateString()}`,
      resourceType: 'LegalEvent',
      resourceId: event._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(event);
  } catch (error) {
    handle(res, error);
  }
};

/** Adjourn — closes this entry and creates its successor. Never a date edit. */
const adjournEvent = async (req, res) => {
  try {
    const result = await diaryService.adjourn(req.params.eventId, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Adjourned "${result.adjourned.title}" to ` +
        `${new Date(result.successor.dueAt).toDateString()} — ${req.body.reason || 'no reason given'}`,
      resourceType: 'LegalEvent',
      resourceId: result.adjourned._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(result);
  } catch (error) {
    handle(res, error);
  }
};

const completeEvent = async (req, res) => {
  try {
    res.status(200).json(await diaryService.completeEvent(req.params.eventId, req.body, req.user));
  } catch (error) {
    handle(res, error);
  }
};

const cancelEvent = async (req, res) => {
  try {
    res.status(200).json(await diaryService.cancelEvent(req.params.eventId, req.body.reason, req.user));
  } catch (error) {
    handle(res, error);
  }
};

// ── Documents ────────────────────────────────────────────────────────────────

const uploadDocument = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const document = await documentService.upload(
      { file: req.file, meta: { ...req.body, company } },
      req.user
    );

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Uploaded ${document.docType} "${document.title}" v${document.version} (${document.confidentiality})`,
      resourceType: 'LegalDocument',
      resourceId: document._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json({ ...document.toObject(), storageKey: undefined });
  } catch (error) {
    handle(res, error);
  }
};

const listDocuments = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(
      await documentService.list({ ...req.query, company }, req.user)
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Mint a short-lived signed link. The service enforces privilege and logs the
 * attempt — including refusals, which are exactly what an auditor wants to see.
 */
const downloadDocument = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const document = await LegalDocument.findById(req.params.documentId).select('company');
    if (!document || !belongsToCompany(document.company, company)) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const result = await documentService.requestAccess(req.params.documentId, req.user, { req });
    res.status(200).json(result);
  } catch (error) {
    handle(res, error);
  }
};

const documentAccessLog = async (req, res) => {
  try {
    res.status(200).json(await documentService.accessLog(req.params.documentId));
  } catch (error) {
    handle(res, error);
  }
};

const reclassifyDocument = async (req, res) => {
  try {
    const document = await documentService.reclassify(
      req.params.documentId,
      req.body.confidentiality,
      req.body.reason,
      req.user
    );

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Reclassified "${document.title}" to ${document.confidentiality} — ${req.body.reason}`,
      resourceType: 'LegalDocument',
      resourceId: document._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json({ ...document.toObject(), storageKey: undefined });
  } catch (error) {
    handle(res, error);
  }
};

const markDocumentFiled = async (req, res) => {
  try {
    const document = await documentService.markFiled(req.params.documentId, req.body, req.user);
    res.status(200).json({ ...document.toObject(), storageKey: undefined });
  } catch (error) {
    handle(res, error);
  }
};

module.exports = {
  listCases,
  getCase,
  createCase,
  appointAdvocate,
  instructionPack,
  issueInstructions,
  recordJudgment,
  createAppeal,
  closeCase,
  listAdvocates,
  getAdvocate,
  createAdvocate,
  updateAdvocate,
  setAdvocateApproval,
  suspendAdvocate,
  suggestAdvocate,
  recomputeAdvocatePerformance,
  issueAdvocateCredentials,
  getDiary,
  getCaseDiary,
  createEvent,
  adjournEvent,
  completeEvent,
  cancelEvent,
  uploadDocument,
  listDocuments,
  downloadDocument,
  documentAccessLog,
  reclassifyDocument,
  markDocumentFiled,
};
