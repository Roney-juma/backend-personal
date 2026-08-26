const bcrypt = require('bcryptjs');
const Advocate = require('../models/advocate.model');
const LegalCase = require('../models/legalCase.model');
const LegalEvent = require('../models/legalEvent.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Claim = require('../models/claim.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const {
  createResetToken,
  verifyResetToken,
  resetEmailBody,
} = require('../utils/passwordReset');
const { assertValidPassword } = require('../utils/passwordPolicy');
const emailService = require('./email.service');
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
/**
 * Counsel's matters.
 *
 * `scope` is what the portal asks on: 'open' (the default), 'closed', or 'all'.
 * Closed matters were previously unreachable — a matter counsel had run for
 * three years vanished the day it was closed, taking the diary, the documents
 * and their own progress reports with it. Counsel still needs that file: to
 * bill against it, to answer a query on it, and to lift a pleading from it.
 *
 * `status` remains supported for an exact status.
 */
const OPEN_SCOPE = { $nin: ['closed'] };

async function myCases(advocateId, { status, scope = 'open' } = {}) {
  const filter = { advocate: advocateId };

  if (status) {
    filter.status = Array.isArray(status) ? { $in: status } : status;
  } else if (scope === 'closed') {
    filter.status = 'closed';
  } else if (scope !== 'all') {
    filter.status = OPEN_SCOPE;
  }

  /**
   * Sorted by what the reader is looking for. An open matter is read forwards —
   * what is due next; a closed one backwards — what ended most recently. Under
   * 'all', closedAt ascending puts the still-open matters (which have none)
   * first, so the live work stays at the top where it belongs.
   */
  const sort =
    scope === 'closed' && !status
      ? { closedAt: -1 }
      : scope === 'all' && !status
        ? { closedAt: 1, nextActionAt: 1 }
        : { nextActionAt: 1 };

  const cases = await LegalCase.find(filter)
    .select(
      'caseNumber courtCaseNumber court courtStation status filedAt nextActionAt nextActionLabel ' +
      'instructionsIssuedAt instructionsAcceptedAt lastProgressReportAt matterType plaintiffs closedAt'
    )
    .sort(sort)
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

  const [exposures, diary, documents, claim] = await Promise.all([
    ThirdPartyClaim.find({ _id: { $in: legalCase.thirdPartyClaims } })
      .select('referenceNumber party claimType injury opposingAdvocate liability limitation status')
      .lean(),
    diaryService.caseDiary(caseId),
    documentService.list(
      { legalCase: caseId, company: legalCase.company },
      actor,
      { isAdvocate: true }
    ),
    /**
     * The accident itself.
     *
     * Counsel cannot plead a defence without the facts of the collision — when
     * and where it happened, which vehicles, who was driving, whether there is a
     * police abstract and who the witnesses are. The instruction pack has always
     * carried exactly this, so nothing new is being disclosed; it was simply
     * unavailable once counsel moved from the pack to the matter on screen.
     *
     * Selected field by field rather than returned whole. A claim document also
     * holds our own damage assessment, our reserve and our fraud position, and
     * none of that is counsel's to see.
     */
    legalCase.claim
      ? Claim.findById(legalCase.claim)
          .select(
            'incidentDetails vehiclesInvolved drivers witnesses policeReport ' +
            'description status createdAt'
          )
          .lean()
      : null,
  ]);

  return {
    // Returned so the client can act on the matter it is showing. Its absence
    // meant every action taken from the detail view had to be handed the id
    // separately, and one that read it off this payload posted to
    // /cases/undefined/... instead.
    _id: legalCase._id,
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
    // The accident, shaped the same way the instruction pack states it.
    accident: claim
      ? {
          date: claim.incidentDetails?.date,
          time: claim.incidentDetails?.time,
          location: claim.incidentDetails?.location,
          description: claim.incidentDetails?.description || claim.description,
          vehicles: claim.vehiclesInvolved,
          drivers: claim.drivers,
          witnesses: claim.witnesses,
          policeReport: claim.policeReport,
          reportedAt: claim.createdAt,
        }
      : null,
    // Counsel's own closing report, so the portal can show what was filed rather
    // than offering to conclude a matter twice.
    closingReport: legalCase.closingReport?.submittedAt ? legalCase.closingReport : null,
    closedAt: legalCase.closedAt,
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
 * Counsel concludes the matter and hands it back.
 *
 * Conclusion is initiated here rather than by the insurer, because the advocate
 * is the one who was in court: they know how it ended, what the decretal sum
 * was, and — the part that cannot wait — whether an appeal is advised and by
 * when. An appeal window runs from delivery regardless of whether anyone on our
 * side has looked at the file yet.
 *
 * This does NOT close the case. It records the report, ticks
 * `finalReportReceived` on the closure checklist and tells the legal team;
 * closing still runs through legalCase.close() and its checklist.
 */
async function submitClosingReport(advocateId, caseId, data = {}) {
  // hydrate: this writes to the matter.
  const legalCase = await assertAssigned(advocateId, caseId, { hydrate: true });
  const money = require('../utils/money');

  if (!String(data.summary || '').trim()) {
    throw new ApiError(400, 'A closing report needs counsel\'s summary of how the matter ended');
  }
  if (!data.outcome) {
    throw new ApiError(400, 'A closing report needs the outcome');
  }
  if (legalCase.status === 'closed') {
    throw new ApiError(409, 'That matter is already closed');
  }
  // An appeal recommendation without the date it expires is not actionable.
  if (data.appealAdvised && !data.appealDeadline) {
    throw new ApiError(400, 'Advising an appeal requires the date the appeal window closes');
  }

  const toMinor = (major, minor) =>
    Number.isInteger(minor) ? minor : major != null ? money.toMinor(major) : undefined;

  const advocate = await Advocate.findById(advocateId).select('name').lean();

  legalCase.closingReport = {
    outcome: data.outcome,
    summary: data.summary,
    awardMinor: toMinor(data.award, data.awardMinor),
    costsMinor: toMinor(data.costs, data.costsMinor),
    interestMinor: toMinor(data.interest, data.interestMinor),
    appealAdvised: Boolean(data.appealAdvised),
    appealDeadline: data.appealDeadline ? new Date(data.appealDeadline) : undefined,
    appealRationale: data.appealRationale,
    recoveryProspects: data.recoveryProspects,
    outstandingActions: data.outstandingActions,
    lessonsLearned: data.lessonsLearned,
    submittedAt: new Date(),
    submittedBy: advocateId,
    submittedByName: advocate?.name,
  };

  legalCase.closureChecklist = {
    ...(legalCase.closureChecklist || {}),
    finalReportReceived: true,
  };

  // The matter is over bar our own closure formalities — but never overwrite a
  // later stage (an appeal already lodged) with a resolution status.
  if (['counsel_appointed', 'pre_litigation', 'litigation', 'settlement', 'judgment'].includes(legalCase.status)) {
    legalCase.status = 'resolution';
  }

  // Counsel's own record of it, so the matter's narrative stays in one place.
  legalCase.progressReports.push({
    summary: `CLOSING REPORT: ${String(data.outcome).replace(/_/g, ' ')}`,
    nextSteps: data.outstandingActions || data.summary,
    submittedAt: new Date(),
    submittedBy: advocateId,
  });
  legalCase.lastProgressReportAt = new Date();

  await legalCase.save();

  const notify = require('./legalNotify.service');
  const msg = notify.templates.closingReportSubmitted({
    caseNumber: legalCase.courtCaseNumber || legalCase.caseNumber,
    advocate: advocate?.name,
    outcome: String(data.outcome).replace(/_/g, ' '),
    summary: data.summary,
    appealAdvised: Boolean(data.appealAdvised),
    appealDeadline: legalCase.closingReport.appealDeadline,
  });

  const { notified } = await notify.sendToRoles({
    company: legalCase.company,
    roles: ['Legal Officer', 'Senior Legal Officer'],
    type: 'legal_closing_report',
    title: msg.title,
    body: msg.body,
    claimId: legalCase.claim,
  });

  logger.info(
    `[advocate-portal] closing report on ${legalCase.caseNumber} (${data.outcome})` +
    (data.appealAdvised ? ' — APPEAL ADVISED' : '')
  );

  return { legalCase, notified };
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
  // hydrate: this pushes a progress report and saves.
  const legalCase = await assertAssigned(advocateId, caseId, { hydrate: true });
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

  const notify = require('./legalNotify.service');
  const advocate = await Advocate.findById(advocateId).select('name').lean();

  const msg = notify.templates.authorityRequested({
    caseNumber: legalCase.courtCaseNumber || legalCase.caseNumber,
    amount: money.formatMinor(requestedMinor),
    advocate: advocate?.name,
    rationale,
  });

  // Reaches the legal team on every channel — an authority request that sits
  // unseen in an in-app list is the one counsel chases by phone anyway.
  const { notified } = await notify.sendToRoles({
    company: legalCase.company,
    roles: ['Legal Officer', 'Senior Legal Officer'],
    type: 'legal_authority_request',
    title: msg.title,
    body: msg.body,
    claimId: legalCase.claim,
  });

  return { requestedMinor, notified };
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
/**
 * Counsel's own diary across every matter they hold.
 *
 * `includeClosed` widens the window to entries already dealt with — done,
 * adjourned, cancelled. The list view does not want them, since "upcoming"
 * means outstanding. A calendar does: a month rendered without the hearings
 * that actually happened shows counsel an emptier past than they lived, and
 * the adjournment trail is most of what a court diary is read for.
 */
async function myDiary(advocateId, { from, to, includeClosed = false } = {}) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(Date.now() + 60 * 86400000);

  const cases = await LegalCase.find({ advocate: advocateId }).select('_id caseNumber courtCaseNumber').lean();
  const caseIds = cases.map((c) => c._id);
  const byId = Object.fromEntries(cases.map((c) => [String(c._id), c]));

  const windowStatus =
    includeClosed === true || includeClosed === 'true'
      ? {}
      : { status: { $in: ['scheduled', 'pending'] } };

  const [upcoming, overdue] = await Promise.all([
    LegalEvent.find({
      legalCase: { $in: caseIds },
      ...windowStatus,
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
/**
 * @param {object} [opts]
 * @param {boolean} [opts.hydrate] Return a real document rather than a lean
 *   object. Callers that only READ leave this off; anything that intends to
 *   `.save()` MUST set it — a lean object has no save() and throws
 *   "legalCase.save is not a function" at the point of writing, long after the
 *   authorisation check that returned it.
 */
async function assertAssigned(advocateId, caseId, { hydrate = false } = {}) {
  const query = LegalCase.findById(caseId);
  const legalCase = hydrate ? await query : await query.lean();
  if (!legalCase) throw new ApiError(404, 'Matter not found');
  if (String(legalCase.advocate || '') !== String(advocateId)) {
    throw new ApiError(404, 'Matter not found');
  }
  return legalCase;
}

// ── Password recovery ────────────────────────────────────────────────────────

/**
 * Start a password reset.
 *
 * Counsel receives a temporary password by email when they are added to a
 * panel, and must change it on first sign-in. Without this they would have to
 * ask the insurer's legal team to reissue it every time they mislaid it, which
 * turns a self-service problem into a support call — and puts staff in the
 * habit of minting passwords for external parties.
 *
 * Mirrors the assessor flow, including its account-enumeration defence: the
 * same response is returned whether or not the address is on any panel.
 */
async function forgotPassword(email) {
  const advocate = await Advocate.findOne({ email: String(email || '').toLowerCase() });

  // A suspended or removed advocate must not be able to let themselves back in.
  if (advocate && advocate.active && advocate.active_account) {
    const { rawToken, hashedToken, expires } = await createResetToken();
    // updateOne, so the model's pre-save hooks cannot re-hash anything.
    await Advocate.updateOne(
      { _id: advocate._id },
      { $set: { resetPasswordToken: hashedToken, resetPasswordExpires: expires } }
    );

    await emailService.sendEmailNotification(
      advocate.email,
      'Your AVICS panel portal password reset code',
      resetEmailBody(advocate.name, rawToken)
    );
    logger.info(`[advocate-portal] reset code issued to ${advocate.email}`);
  }

  return { message: 'If an account exists for that email, a reset link has been sent.' };
}

async function resetPassword(email, token, newPassword) {
  const advocate = await Advocate.findOne({ email: String(email || '').toLowerCase() });
  if (!advocate || !(await verifyResetToken(token, advocate))) {
    throw new ApiError(400, 'Reset token is invalid or has expired');
  }
  if (!advocate.active || !advocate.active_account) {
    throw new ApiError(403, 'This panel account is not active');
  }

  assertValidPassword(newPassword);

  const hashed = await bcrypt.hash(newPassword, 10);
  await Advocate.updateOne(
    { _id: advocate._id },
    {
      // A completed reset also satisfies the forced first-login change, and
      // clears any lockout — otherwise the new password is refused for the rest
      // of the window and reads as though the reset never worked.
      $set: { password: hashed, mustChangePassword: false, failedLoginAttempts: 0 },
      $unset: { resetPasswordToken: '', resetPasswordExpires: '', lockUntil: '' },
    }
  );

  logger.info(`[advocate-portal] password reset completed for ${advocate.email}`);
  return { message: 'Password has been reset successfully' };
}

// ── Self-service profile ─────────────────────────────────────────────────────

/**
 * Update the signed-in advocate's own contact details.
 *
 * Deliberately narrow. Panel standing — approval, the rate agreement, contract
 * dates, performance — belongs to the insurer, so counsel can correct how they
 * are reached and nothing else. The identity comes from the token; no id is
 * accepted from the request.
 */
async function updateProfile(advocateId, changes = {}) {
  const advocate = await Advocate.findById(advocateId);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  const SELF_EDITABLE = ['name', 'phone', 'practiceAreas', 'counties', 'courts', 'location', 'fcmToken'];
  for (const key of SELF_EDITABLE) {
    if (changes[key] !== undefined) advocate[key] = changes[key];
  }
  // The firm's own contact block, but never its banking or panel terms.
  if (changes.firm) {
    advocate.firm.address = changes.firm.address ?? advocate.firm.address;
    advocate.firm.physicalAddress = changes.firm.physicalAddress ?? advocate.firm.physicalAddress;
    advocate.firm.contactPersons = changes.firm.contactPersons ?? advocate.firm.contactPersons;
  }

  await advocate.save();
  return advocate;
}

module.exports = {
  login,
  forgotPassword,
  resetPassword,
  updateProfile,
  myCases,
  caseDetail,
  acceptInstructions,
  addCourtDate,
  adjournCourtDate,
  submitProgressReport,
  submitClosingReport,
  requestAuthority,
  uploadDocument,
  downloadDocument,
  myDiary,
  assertAssigned,
};
