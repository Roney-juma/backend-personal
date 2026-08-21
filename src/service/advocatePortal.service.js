const bcrypt = require('bcryptjs');
const Advocate = require('../models/advocate.model');
const LegalCase = require('../models/legalCase.model');
const LegalEvent = require('../models/legalEvent.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const documentService = require('./legalDocument.service');
const diaryService = require('./legalDiary.service');
const legalCaseService = require('./legalCase.service');

/**
 * The advocate portal.
 *
 * Panel advocates sign into partner-fe alongside assessors and garages, using
 * the same shell. Everything here is scoped to matters actually assigned to the
 * signed-in advocate, and the scoping is enforced HERE rather than in the
 * controller, so no route can accidentally skip it.
 *
 * The governing rule: an advocate is an external party. They see the matters
 * they defend and the documents shared with them, and nothing else — not our
 * valuation, not our reserve, not our internal assessment of the case. Those are
 * privileged, and putting them behind a portal login would be a disclosure risk
 * for no operational gain.
 */

async function login(email, password) {
  const advocate = await Advocate.findOne({ email: String(email || '').toLowerCase() });
  if (!advocate) throw new ApiError(401, 'Invalid email or password');

  if (!advocate.active_account || !advocate.password) {
    throw new ApiError(403, 'Portal access has not been issued for this account');
  }
  if (advocate.lockUntil && advocate.lockUntil > new Date()) {
    throw new ApiError(423, 'This account is temporarily locked. Try again later.');
  }

  const match = await bcrypt.compare(String(password), advocate.password);
  if (!match) {
    advocate.failedLoginAttempts = (advocate.failedLoginAttempts || 0) + 1;
    // Same lockout shape the other partner accounts use.
    if (advocate.failedLoginAttempts >= 5) {
      advocate.lockUntil = new Date(Date.now() + 15 * 60000);
    }
    await advocate.save();
    throw new ApiError(401, 'Invalid email or password');
  }

  // A suspended advocate keeps their history but must not pick up new work or
  // read the file — suspension is usually a conduct or contract issue.
  if (!advocate.active) {
    throw new ApiError(403, 'This panel account is currently suspended');
  }

  advocate.failedLoginAttempts = 0;
  advocate.lockUntil = undefined;
  advocate.lastLogin = new Date();
  await advocate.save();

  return advocate;
}

/** Every matter assigned to this advocate. The only list they ever see. */
async function myCases(advocateId, { status } = {}) {
  const filter = { advocate: advocateId };
  if (status) filter.status = Array.isArray(status) ? { $in: status } : status;
  else filter.status = { $nin: ['closed'] };

  const cases = await LegalCase.find(filter)
    .select(
      'caseNumber courtCaseNumber court courtStation status filedAt nextActionAt nextActionLabel ' +
      'instructionsIssuedAt instructionsAcceptedAt lastProgressReportAt matterType plaintiffs'
    )
    .sort({ nextActionAt: 1 })
    .lean();

  return cases;
}

/**
 * One matter, as counsel is permitted to see it.
 *
 * Note what is absent: no reserve, no exposure, no quantum assessment, no
 * ledger. The claimant details and the liability position ARE included, because
 * counsel cannot defend without them.
 */
async function caseDetail(advocateId, caseId, actor) {
  const legalCase = await assertAssigned(advocateId, caseId);

  const [exposures, diary, documents] = await Promise.all([
    ThirdPartyClaim.find({ _id: { $in: legalCase.thirdPartyClaims } })
      .select('referenceNumber party claimType injury opposingAdvocate liability limitation status')
      .lean(),
    diaryService.caseDiary(caseId),
    documentService.list(
      { legalCase: caseId, company: legalCase.company },
      actor,
      { isAdvocate: true }
    ),
  ]);

  return {
    caseNumber: legalCase.caseNumber,
    courtCaseNumber: legalCase.courtCaseNumber,
    court: legalCase.court,
    courtStation: legalCase.courtStation,
    status: legalCase.status,
    matterType: legalCase.matterType,
    filedAt: legalCase.filedAt,
    servedAt: legalCase.servedAt,
    plaintiffs: legalCase.plaintiffs,
    defendants: legalCase.defendants,
    specificInstructions: legalCase.specificInstructions,
    instructionsIssuedAt: legalCase.instructionsIssuedAt,
    instructionsAcceptedAt: legalCase.instructionsAcceptedAt,
    // Cover terms counsel needs to plead, without the commercial detail.
    cover: legalCase.coverSnapshot
      ? {
          policyNumber: legalCase.coverSnapshot.policyNumber,
          policyType: legalCase.coverSnapshot.policyType,
          status: legalCase.coverSnapshot.status,
          startDate: legalCase.coverSnapshot.startDate,
          expiryDate: legalCase.coverSnapshot.expiryDate,
          exclusions: legalCase.coverSnapshot.exclusions,
        }
      : null,
    claimants: exposures,
    diary: diary.events,
    adjournmentCount: diary.adjournmentCount,
    documents,
    judgment: legalCase.judgment,
  };
}

/** Accept instructions — the acknowledgement the insurer waits on. */
async function acceptInstructions(advocateId, caseId) {
  const legalCase = await LegalCase.findById(caseId);
  await assertAssigned(advocateId, caseId);

  if (!legalCase.instructionsIssuedAt) {
    throw new ApiError(409, 'Instructions have not been issued on this matter yet');
  }
  if (legalCase.instructionsAcceptedAt) return legalCase;

  legalCase.instructionsAcceptedAt = new Date();
  await legalCase.save();

  logger.info(`[advocate-portal] instructions accepted on ${legalCase.caseNumber}`);
  return legalCase;
}

/**
 * Enter a court date.
 *
 * Counsel is in the room when the date is given, so this is the fastest and most
 * reliable path into the diary — and it is the whole point of the portal. The
 * entry is stamped `advocate_portal` so its provenance is visible.
 */
async function addCourtDate(advocateId, caseId, data, actor) {
  const legalCase = await assertAssigned(advocateId, caseId);

  return diaryService.createEvent(
    {
      ...data,
      legalCase: caseId,
      company: legalCase.company,
      responsibleType: 'Advocate',
      responsible: advocateId,
    },
    actor,
    { source: 'advocate_portal' }
  );
}

async function adjournCourtDate(advocateId, eventId, data, actor) {
  const event = await LegalEvent.findById(eventId).select('legalCase').lean();
  if (!event?.legalCase) throw new ApiError(404, 'Diary entry not found');
  await assertAssigned(advocateId, event.legalCase);

  return diaryService.adjourn(eventId, data, { ...actor, accountType: 'Advocate' });
}

/**
 * Submit a progress report. Clears the chaser.
 */
async function submitProgressReport(advocateId, caseId, { summary, nextSteps }) {
  if (!String(summary || '').trim()) throw new ApiError(400, 'A progress report needs a summary');

  const legalCase = await LegalCase.findById(caseId);
  await assertAssigned(advocateId, caseId);

  legalCase.progressReports.push({
    summary,
    nextSteps,
    submittedAt: new Date(),
    submittedBy: advocateId,
  });
  legalCase.lastProgressReportAt = new Date();
  await legalCase.save();

  return legalCase;
}

/**
 * Request settlement authority.
 *
 * Counsel cannot approve anything — they ask, and the insurer's own authority
 * matrix decides. This deliberately does NOT create an ApprovalRequest: an
 * advocate's view of what a case is worth is advice, and it becomes a proposal
 * only when a Legal Officer adopts it.
 */
async function requestAuthority(advocateId, caseId, { amount, amountMinor, rationale }) {
  const legalCase = await assertAssigned(advocateId, caseId);
  const money = require('../utils/money');

  const requestedMinor = Number.isInteger(amountMinor) ? amountMinor : money.toMinor(amount);
  if (requestedMinor <= 0) throw new ApiError(400, 'An authority request needs an amount');
  if (!String(rationale || '').trim()) {
    throw new ApiError(400, 'An authority request needs counsel\'s rationale');
  }

  // Recorded as a note on the matter and notified to the legal team.
  legalCase.progressReports.push({
    summary: `AUTHORITY REQUESTED: ${money.formatMinor(requestedMinor)}`,
    nextSteps: rationale,
    submittedAt: new Date(),
    submittedBy: advocateId,
  });
  await legalCase.save();

  const notifications = require('./notification.service');
  const User = require('../models/users.model');
  const Role = require('../models/roles.model');

  const roles = await Role.find({ company: legalCase.company, name: { $in: ['Legal Officer', 'Senior Legal Officer'] } })
    .select('_id')
    .lean();
  const recipients = await User.find({ company: legalCase.company, role: { $in: roles.map((r) => r._id) }, active: true })
    .select('_id')
    .limit(10)
    .lean();

  const advocate = await Advocate.findById(advocateId).select('name').lean();

  for (const recipient of recipients) {
    await notifications
      .createAndEmit({
        recipientId: recipient._id,
        recipientType: 'admin',
        type: 'legal_authority_request',
        title: `Counsel requests authority — ${legalCase.caseNumber}`,
        content:
          `${advocate?.name || 'Counsel'} requests settlement authority of ` +
          `${money.formatMinor(requestedMinor)} on ${legalCase.courtCaseNumber || legalCase.caseNumber}.\n\n${rationale}`,
        claimId: legalCase.claim,
      })
      .catch((err) => logger.warn(`[advocate-portal] authority notify failed: ${err.message}`));
  }

  return { requestedMinor, notified: recipients.length };
}

/** Upload a pleading. Forced to advocate_shared — see legalDocument.service. */
async function uploadDocument(advocateId, caseId, { file, meta }, actor) {
  const legalCase = await assertAssigned(advocateId, caseId);

  return documentService.upload(
    {
      file,
      meta: { ...meta, legalCase: caseId, claim: legalCase.claim, company: legalCase.company },
    },
    { ...actor, _id: advocateId },
    { actorType: 'Advocate' }
  );
}

/** Download, through the same privilege check every other reader goes through. */
async function downloadDocument(advocateId, documentId, actor, req) {
  const LegalDocument = require('../models/legalDocument.model');
  const document = await LegalDocument.findById(documentId).select('legalCase').lean();
  if (!document?.legalCase) throw new ApiError(404, 'Document not found');
  await assertAssigned(advocateId, document.legalCase);

  return documentService.requestAccess(documentId, { ...actor, _id: advocateId }, {
    req,
    isAdvocate: true,
  });
}

/** Counsel's own diary across every matter they hold. */
async function myDiary(advocateId, { from, to } = {}) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(Date.now() + 60 * 86400000);

  const cases = await LegalCase.find({ advocate: advocateId }).select('_id caseNumber courtCaseNumber').lean();
  const caseIds = cases.map((c) => c._id);
  const byId = Object.fromEntries(cases.map((c) => [String(c._id), c]));

  const [upcoming, overdue] = await Promise.all([
    LegalEvent.find({
      legalCase: { $in: caseIds },
      status: { $in: ['scheduled', 'pending'] },
      dueAt: { $gte: start, $lte: end },
    })
      .sort({ dueAt: 1 })
      .lean(),
    LegalEvent.find({
      legalCase: { $in: caseIds },
      status: { $in: ['scheduled', 'pending', 'missed'] },
      dueAt: { $lt: new Date() },
    })
      .sort({ dueAt: 1 })
      .lean(),
  ]);

  const decorate = (e) => ({
    ...e,
    case: byId[String(e.legalCase)],
    daysUntil: Math.ceil((new Date(e.dueAt).getTime() - Date.now()) / 86400000),
  });

  return { upcoming: upcoming.map(decorate), overdue: overdue.map(decorate) };
}

/**
 * The scoping gate. Every portal operation goes through this.
 *
 * Deliberately returns 404 rather than 403 on a matter belonging to someone
 * else: confirming that a case number exists but is not yours still leaks which
 * insurer is litigating what.
 */
async function assertAssigned(advocateId, caseId) {
  const legalCase = await LegalCase.findById(caseId).lean();
  if (!legalCase) throw new ApiError(404, 'Matter not found');
  if (String(legalCase.advocate || '') !== String(advocateId)) {
    throw new ApiError(404, 'Matter not found');
  }
  return legalCase;
}

module.exports = {
  login,
  myCases,
  caseDetail,
  acceptInstructions,
  addCourtDate,
  adjournCourtDate,
  submitProgressReport,
  requestAuthority,
  uploadDocument,
  downloadDocument,
  myDiary,
  assertAssigned,
};
