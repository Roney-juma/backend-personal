const LegalCase = require('../models/legalCase.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Claim = require('../models/claim.model');
const Customer = require('../models/customerModel');
const Advocate = require('../models/advocate.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/ApiError');
const { searchRegex } = require('../utils/searchRegex');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const legalLedger = require('./legalLedger.service');
const legalDocumentService = require('./legalDocument.service');
const thirdPartyClaimService = require('./thirdPartyClaim.service');
const { MATTER_TYPES } = require('../constants/legal.constants');

/**
 * The litigation file.
 *
 * A LegalCase is created when a SUIT IS FILED, not when a claimant appears —
 * see thirdPartyClaim.service for the register that exists from first demand.
 * One case can cover several claimants: three passengers suing on one plaint is
 * one case and three exposures, and the money stays on the exposures.
 */

/**
 * Open a case on an existing matter.
 *
 * @param {Object} data
 * @param {Array}  data.thirdPartyClaims  the exposures this suit covers
 * @param {Object} [actor]
 */
async function create(data, actor = null) {
  const tpcIds = data.thirdPartyClaims || (data.thirdPartyClaim ? [data.thirdPartyClaim] : []);
  const matterType = data.matterType || MATTER_TYPES.THIRD_PARTY_LIABILITY;

  let claim;
  let company;
  let exposures = [];

  if (tpcIds.length) {
    exposures = await ThirdPartyClaim.find({ _id: { $in: tpcIds } });
    if (exposures.length !== tpcIds.length) {
      throw new ApiError(404, 'One or more third-party claims were not found');
    }

    // All claimants on one suit must belong to one accident — otherwise the
    // case's financial roll-up spans two events and means nothing.
    const claimIds = new Set(exposures.map((e) => String(e.claim)));
    if (claimIds.size > 1) {
      throw new ApiError(
        400,
        'Those third-party claims arise from different accidents and cannot share one suit'
      );
    }
    company = exposures[0].company;
    claim = await Claim.findById(exposures[0].claim);
  } else {
    // Coverage disputes and repudiation challenges have no third-party claimant
    // — the insured is suing us.
    if (!data.claim) throw new ApiError(400, 'A legal case needs either third-party claims or a claim');
    claim = await Claim.findById(data.claim);
    if (!claim) throw new ApiError(404, 'Claim not found');
    company = claim.company;
  }

  if (!company) throw new ApiError(400, 'Cannot determine the insurer for this matter');

  const caseNumber = await Counter.nextReference({ prefix: 'LEG', company });

  const legalCase = await LegalCase.create({
    caseNumber,
    referralNumber: data.referralNumber,
    claim: claim._id,
    company,
    matterType,
    thirdPartyClaims: exposures.map((e) => e._id),

    court: data.court,
    courtStation: data.courtStation,
    courtCaseNumber: data.courtCaseNumber,
    filedAt: data.filedAt ? new Date(data.filedAt) : new Date(),
    servedAt: data.servedAt,
    plaintiffs: data.plaintiffs || exposures.map((e) => ({
      name: e.party?.name,
      advocate: e.opposingAdvocate?.firm || e.opposingAdvocate?.name,
    })),
    defendants: data.defendants || [{ name: 'The insured', isInsured: true }],

    coverSnapshot: await snapshotCover(claim),

    status: 'litigation',
    riskRating: data.riskRating || 'medium',
    referredBy: actor?._id || actor?.id || null,
    referredAt: new Date(),
    referralReason: data.referralReason,
    referralTrigger: data.referralTrigger,
  });

  // Point the exposures at the suit and move their status on.
  for (const exposure of exposures) {
    exposure.legalCase = legalCase._id;
    exposure.status = 'suit_filed';
    await exposure.save();
  }

  if (exposures.length) {
    await thirdPartyClaimService.recomputeClaimRollup(claim._id);
  }

  logger.info(
    `[legal-case] ${caseNumber} opened (${matterType}) covering ${exposures.length} exposure(s) ` +
    `in ${data.court || 'an unnamed court'}`
  );
  return legalCase;
}

/**
 * Freeze the policy terms as they stood at the accident.
 *
 * A policy is renewed, endorsed and amended over the years a matter runs. What
 * answers in court is the cover in force on the day of the accident, so this is
 * captured once and never refreshed — a live lookup years later would show the
 * wrong policy and nobody would notice.
 */
async function snapshotCover(claim) {
  try {
    if (!claim?.customerId) return undefined;
    const customer = await Customer.findById(claim.customerId).select('policies policyNumber').lean();
    if (!customer) return undefined;

    const wanted = claim.policyRef?.policyNumber || customer.policyNumber;
    const registrations = (claim.vehiclesInvolved || [])
      .map((v) => String(v.licensePlate || '').toUpperCase().replace(/[\s-]/g, ''))
      .filter(Boolean);

    const policy =
      (customer.policies || []).find((p) => p.policyNumber === wanted) ||
      (customer.policies || []).find((p) =>
        registrations.includes(String(p.vehicle?.registration || '').toUpperCase().replace(/[\s-]/g, ''))
      );

    if (!policy) return undefined;

    return {
      policyNumber: policy.policyNumber,
      policyType: policy.policyType,
      status: policy.status,
      startDate: policy.startDate,
      expiryDate: policy.expiryDate,
      liabilityLimits: policy.liabilityLimits,
      excessMinor: policy.excessMinor,
      exclusions: policy.exclusions,
      endorsements: (policy.endorsements || []).map((e) => e.code || e.description).filter(Boolean),
      snapshotAt: new Date(),
    };
  } catch (err) {
    logger.warn(`[legal-case] cover snapshot failed for claim ${claim?._id}: ${err.message}`);
    return undefined;
  }
}

/**
 * Appoint counsel.
 *
 * Records HOW the advocate was chosen — ranked, random or manual, and the score
 * if ranked — so an insurer can later review whether its allocation policy is
 * actually being followed.
 */
async function appointAdvocate(caseId, { advocate: advocateId, allocationMode, allocationScore, instructions }, actor = null) {
  const legalCase = await LegalCase.findById(caseId);
  if (!legalCase) throw new ApiError(404, 'Legal case not found');

  const advocate = await Advocate.findById(advocateId);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  if (String(advocate.company) !== String(legalCase.company)) {
    throw new ApiError(403, 'That advocate is on another insurer\'s panel');
  }
  if (!advocate.approved || !advocate.active) {
    throw new ApiError(409, `${advocate.name} is not currently approved for panel duty`);
  }
  if (advocate.contractExpiry && new Date(advocate.contractExpiry) < new Date()) {
    throw new ApiError(
      409,
      `${advocate.name}'s retainer expired on ${new Date(advocate.contractExpiry).toDateString()}`
    );
  }

  const previous = legalCase.advocate;

  legalCase.advocate = advocate._id;
  legalCase.appointedAt = new Date();
  legalCase.appointedBy = actor?._id || actor?.id || null;
  legalCase.allocationMode = allocationMode || 'manual';
  legalCase.allocationScore = allocationScore;
  legalCase.specificInstructions = instructions;
  if (legalCase.status === 'referred' || legalCase.status === 'under_review') {
    legalCase.status = 'counsel_appointed';
  }
  await legalCase.save();

  logger.info(
    `[legal-case] ${legalCase.caseNumber} assigned to ${advocate.name} (${legalCase.allocationMode})` +
    (previous ? ` — reassigned from ${previous}` : '')
  );

  // Counsel is not sitting in the portal waiting to be told. Email and WhatsApp
  // are how an appointment actually reaches them, and an appointment they learn
  // about late is a return date they prepare for late.
  const notify = require('./legalNotify.service');
  const msg = notify.templates.counselAppointed({
    caseNumber: legalCase.caseNumber,
    court: legalCase.court,
    courtCase: legalCase.courtCaseNumber,
    instructions,
  });
  notify
    .sendToAdvocate({
      advocateId: advocate._id,
      type: 'legal_counsel_appointed',
      title: msg.title,
      body: msg.body,
      claimId: legalCase.claim,
    })
    .catch((err) =>
      logger.error(`[legal-case] could not notify ${advocate.name} of appointment: ${err.message}`)
    );

  return { legalCase, advocate, reassignedFrom: previous };
}

/**
 * Assemble the instruction pack.
 *
 * Everything counsel needs, gathered from records AVICS already holds rather
 * than re-keyed: the accident, the cover in force, the exposures with their
 * apportionment and quantum, and the documents already shareable with counsel.
 *
 * Returns the pack rather than sending it — the Legal Officer reviews it before
 * it goes, because an instruction pack that accidentally includes our own
 * privileged assessment is a disclosure problem.
 */
async function buildInstructionPack(caseId, actor = null) {
  const legalCase = await LegalCase.findById(caseId)
    .populate('advocate', 'name firm email')
    .lean();
  if (!legalCase) throw new ApiError(404, 'Legal case not found');

  const [claim, exposures, documents] = await Promise.all([
    Claim.findById(legalCase.claim)
      .select('incidentDetails vehiclesInvolved drivers witnesses policeReport supportingDocuments damage description')
      .lean(),
    ThirdPartyClaim.find({ _id: { $in: legalCase.thirdPartyClaims } }).lean(),
    legalDocumentService.list(
      { legalCase: caseId, company: legalCase.company },
      actor,
      { isAdvocate: false }
    ),
  ]);

  const position = await legalLedger.position({ legalCase: caseId }).catch(() => null);

  return {
    case: {
      caseNumber: legalCase.caseNumber,
      court: legalCase.court,
      courtStation: legalCase.courtStation,
      courtCaseNumber: legalCase.courtCaseNumber,
      filedAt: legalCase.filedAt,
      matterType: legalCase.matterType,
    },
    advocate: legalCase.advocate,
    accident: claim
      ? {
          date: claim.incidentDetails?.date,
          location: claim.incidentDetails?.location,
          description: claim.incidentDetails?.description || claim.description,
          vehicles: claim.vehiclesInvolved,
          drivers: claim.drivers,
          witnesses: claim.witnesses,
          policeReport: claim.policeReport,
        }
      : null,
    cover: legalCase.coverSnapshot,
    claimants: exposures.map((e) => ({
      referenceNumber: e.referenceNumber,
      party: e.party,
      claimType: e.claimType,
      injury: e.injury,
      opposingAdvocate: e.opposingAdvocate,
      liability: e.liability,
      quantumDemandedMinor: e.quantum?.demandedMinor,
      // Our own valuation and reserve are deliberately NOT in the pack. They are
      // our privileged assessment of what we might pay, and counsel does not
      // need them to defend — sending them creates a disclosure risk for no gain.
      exposureNote: 'Our valuation and reserve are held internally and available on request.',
      limitation: e.limitation,
    })),
    documents: documents
      .filter((d) => ['advocate_shared', 'court_filed'].includes(d.confidentiality))
      .map((d) => ({ _id: d._id, title: d.title, docType: d.docType, version: d.version })),
    financialSummary: position
      ? { costsToDateMinor: position.feesToDateMinor, netExposureMinor: position.netExposureMinor }
      : null,
    specificInstructions: legalCase.specificInstructions,
    // Flagged so the reviewer knows what is missing before it goes out.
    gaps: [
      !claim?.policeReport?.reportNumber && 'No police abstract on file',
      !exposures.length && 'No third-party claimants linked to this suit',
      !documents.some((d) => d.docType === 'plaint') && 'The plaint has not been uploaded',
    ].filter(Boolean),
  };
}

async function issueInstructions(caseId, actor = null) {
  const legalCase = await LegalCase.findById(caseId);
  if (!legalCase) throw new ApiError(404, 'Legal case not found');
  if (!legalCase.advocate) throw new ApiError(409, 'Appoint an advocate before issuing instructions');

  legalCase.instructionsIssuedAt = new Date();
  await legalCase.save();
  return legalCase;
}

// ── Judgment ─────────────────────────────────────────────────────────────────

/**
 * Record judgment. Posts the award, interest and costs to the ledger — a
 * judgment against us is a liability from the day it is delivered.
 */
async function recordJudgment(caseId, data, actor = null) {
  const legalCase = await LegalCase.findById(caseId);
  if (!legalCase) throw new ApiError(404, 'Legal case not found');
  if (legalCase.judgment?.deliveredAt) {
    throw new ApiError(409, 'Judgment has already been recorded on this case');
  }

  const toMinor = (key) =>
    Number.isInteger(data[`${key}Minor`]) ? data[`${key}Minor`] : data[key] ? money.toMinor(data[key]) : 0;

  const awardMinor = toMinor('award');
  const interestMinor = toMinor('interest');
  const costsMinor = toMinor('costs');
  const totalMinor = money.sumMinor([awardMinor, interestMinor, costsMinor]);

  legalCase.judgment = {
    deliveredAt: data.deliveredAt ? new Date(data.deliveredAt) : new Date(),
    awardMinor,
    interestMinor,
    costsMinor,
    totalMinor,
    interestRatePercent: data.interestRatePercent,
    interestFrom: data.interestFrom,
    liabilityOutcome: data.liabilityOutcome,
    apportionmentPercent: data.apportionmentPercent,
    summary: data.summary,
    documents: data.documents,
  };
  legalCase.status = 'judgment';
  await legalCase.save();

  // A judgment for the insurer costs nothing but our own costs, so nothing is
  // posted against exposure.
  const againstUs = !['for_insurer', 'dismissed', 'struck_out'].includes(data.liabilityOutcome);

  if (againstUs && totalMinor > 0) {
    const exposures = await ThirdPartyClaim.find({ _id: { $in: legalCase.thirdPartyClaims } }).lean();
    // Attribute to the single claimant where there is one; otherwise leave it at
    // case level rather than inventing a split.
    const soleExposure = exposures.length === 1 ? exposures[0]._id : undefined;

    const post = (entryType, amountMinor, description) =>
      amountMinor > 0 &&
      legalLedger.post(
        {
          company: legalCase.company,
          claim: legalCase.claim,
          thirdPartyClaim: soleExposure,
          legalCase: legalCase._id,
          entryType,
          amountMinor,
          sourceRef: { model: 'LegalCase', id: legalCase._id },
          status: 'accrued',
          description,
        },
        actor
      );

    await post('judgment', awardMinor, `Judgment in ${legalCase.caseNumber}`);
    await post('interest', interestMinor, `Interest on judgment in ${legalCase.caseNumber}`);
    await post('claimant_costs', costsMinor, `Costs awarded in ${legalCase.caseNumber}`);

    for (const exposure of exposures) {
      await ThirdPartyClaim.updateOne({ _id: exposure._id }, { $set: { status: 'judgment' } });
    }
    await thirdPartyClaimService.recomputeClaimRollup(legalCase.claim);
  }

  logger.info(
    `[legal-case] judgment in ${legalCase.caseNumber}: ${data.liabilityOutcome} — ` +
    `${money.formatMinor(totalMinor)}${againstUs ? ' against us' : ''}`
  );
  return legalCase;
}

/**
 * Open an appeal as a CHILD case, so the original's history stays intact and
 * both remain separately reportable.
 */
async function createAppeal(caseId, data, actor = null) {
  const parent = await LegalCase.findById(caseId);
  if (!parent) throw new ApiError(404, 'Legal case not found');
  if (!parent.judgment?.deliveredAt) {
    throw new ApiError(409, 'There is no judgment on that case to appeal');
  }

  const caseNumber = await Counter.nextReference({ prefix: 'LEG', company: parent.company });

  const appeal = await LegalCase.create({
    caseNumber,
    claim: parent.claim,
    company: parent.company,
    matterType: parent.matterType,
    thirdPartyClaims: parent.thirdPartyClaims,
    court: data.court || 'Court of Appeal',
    courtStation: data.courtStation,
    courtCaseNumber: data.courtCaseNumber,
    filedAt: data.filedAt ? new Date(data.filedAt) : new Date(),
    coverSnapshot: parent.coverSnapshot,
    status: 'appeal',
    parentCase: parent._id,
    isAppeal: true,
    advocate: data.advocate || parent.advocate,
    referredBy: actor?._id || actor?.id || null,
    referredAt: new Date(),
    referralReason: data.grounds,
  });

  parent.judgment.appealed = true;
  parent.status = 'appeal';
  await parent.save();

  logger.info(`[legal-case] appeal ${caseNumber} opened against ${parent.caseNumber}`);
  return appeal;
}

// ── Close ────────────────────────────────────────────────────────────────────

/**
 * Close a matter, against the spec §8 stage-9 checklist.
 *
 * The checklist is enforced rather than decorative: a matter closed with the
 * advocate's fees unsettled or the recovery neither completed nor written off
 * is a matter that will be reopened, and the figures in every report until then
 * are wrong.
 */
async function close(caseId, data, actor = null) {
  const legalCase = await LegalCase.findById(caseId);
  if (!legalCase) throw new ApiError(404, 'Legal case not found');

  const checklist = { ...(legalCase.closureChecklist || {}), ...(data.closureChecklist || {}) };
  const REQUIRED = [
    ['settlementOrJudgmentPaid', 'the settlement or judgment has been paid'],
    ['advocateFeesSettled', 'advocate fees are settled'],
    ['recoveryCompletedOrWrittenOff', 'any recovery is completed or written off'],
  ];

  /**
   * Counsel's closing report is required whenever a matter had counsel. Closing
   * an advocate's matter without their report means closing it without knowing
   * how it ended or whether an appeal window is still open — and the report is
   * one click for them, submitted from the partner portal.
   */
  if (legalCase.advocate) {
    REQUIRED.push(['finalReportReceived', "counsel's closing report has been received"]);
  }

  const outstanding = REQUIRED.filter(([key]) => !checklist[key]).map(([, label]) => label);
  if (outstanding.length && !data.force) {
    throw new ApiError(
      409,
      `Cannot close ${legalCase.caseNumber} until ${outstanding.join(', ')}. ` +
      'Tick the outstanding items, or close with force and a reason if they do not apply.'
    );
  }
  if (outstanding.length && data.force && !String(data.lessonsLearned || '').trim()) {
    throw new ApiError(400, 'Force-closing an incomplete matter requires a note explaining why');
  }

  legalCase.closureChecklist = checklist;
  legalCase.lessonsLearned = data.lessonsLearned;
  legalCase.status = 'closed';
  legalCase.closedAt = new Date();
  legalCase.closedBy = actor?._id || actor?.id || null;
  await legalCase.save();

  for (const id of legalCase.thirdPartyClaims || []) {
    await ThirdPartyClaim.updateOne(
      { _id: id, status: { $nin: ['paid', 'closed'] } },
      { $set: { status: 'closed', closedAt: new Date() } }
    );
  }
  await thirdPartyClaimService.recomputeClaimRollup(legalCase.claim);

  logger.info(
    `[legal-case] ${legalCase.caseNumber} closed` +
    (outstanding.length ? ` (FORCED — outstanding: ${outstanding.join(', ')})` : '')
  );
  return legalCase;
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function list({ company, status, matterType, advocate, court, search, page = 1, limit = 25 }) {
  const filter = {};
  if (company) filter.company = company;
  if (status) filter.status = Array.isArray(status) ? { $in: status } : status;
  if (matterType) filter.matterType = matterType;
  if (advocate) filter.advocate = advocate;
  if (court) filter.court = court;

  // Whatever a legal officer has to hand: our reference, the court's, or a party.
  const rx = searchRegex(search);
  if (rx) {
    filter.$or = [
      { caseNumber: rx },
      { courtCaseNumber: rx },
      { court: rx },
      { courtStation: rx },
      { 'plaintiffs.name': rx },
      { 'defendants.name': rx },
    ];
  }

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    LegalCase.find(filter)
      .sort({ nextActionAt: 1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('advocate', 'name firm')
      .lean(),
    LegalCase.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) };
}

async function getById(id, actor = null) {
  const legalCase = await LegalCase.findById(id)
    .populate('advocate', 'name firm email phone performance')
    .populate('thirdPartyClaims')
    .lean();
  if (!legalCase) throw new ApiError(404, 'Legal case not found');

  const [position, documents] = await Promise.all([
    legalLedger.position({ legalCase: id }).catch(() => null),
    legalDocumentService.list({ legalCase: id, company: legalCase.company }, actor).catch(() => []),
  ]);

  return { ...legalCase, position, documents };
}

module.exports = {
  create,
  appointAdvocate,
  buildInstructionPack,
  issueInstructions,
  recordJudgment,
  createAppeal,
  close,
  list,
  getById,
  snapshotCover,
};
