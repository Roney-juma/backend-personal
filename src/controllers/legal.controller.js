const thirdPartyClaimService = require('../service/thirdPartyClaim.service');
const legalIntakeService = require('../service/legalIntake.service');
const limitationService = require('../service/limitation.service');
const legalConfigService = require('../service/legalConfig.service');
const legalLedger = require('../service/legalLedger.service');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const ApiError = require('../utils/ApiError');
const money = require('../utils/money');

/**
 * Legal module HTTP layer.
 *
 * Two rules run through everything here:
 *   - Tenant scope comes from the token, never the body. A company user can only
 *     ever see and touch their own insurer's matters.
 *   - Liability, quantum and reserve changes are audited with before/after
 *     values. They are the numbers that decide what the insurer pays, so
 *     "who changed this and what was it before" has to be answerable years later.
 */

/** Load a third-party claim and confirm the caller's tenant owns it. */
async function loadScoped(req) {
  const company = await getRequesterCompany(req);
  const tpc = await ThirdPartyClaim.findById(req.params.id).select('company claim referenceNumber');
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');
  if (!belongsToCompany(tpc.company, company)) throw new ApiError(404, 'Third-party claim not found');
  return { tpc, company };
}

// ── Intake ───────────────────────────────────────────────────────────────────

/**
 * Match an incoming demand against accidents already on file and the policy in
 * force, BEFORE anything is created. Opening a duplicate accident record splits
 * one event's exposure across two files, so this is a deliberate look-first step.
 */
const matchDemand = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const { registration, accidentDate, windowDays } = req.query;
    const result = await legalIntakeService.matchDemand({
      company,
      registration,
      accidentDate,
      windowDays: windowDays ? Number(windowDays) : undefined,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

/**
 * Record a third-party demand. Opens the accident record too when the insured
 * never reported it.
 */
const recordDemand = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    if (!company) {
      return res.status(400).json({ message: 'Only insurer users can record a third-party demand' });
    }

    const result = await legalIntakeService.recordDemand({ ...req.body, company }, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Recorded third-party demand ${result.thirdPartyClaim.referenceNumber} from ${req.body.party?.name}` +
        (result.createdClaim ? ` (opened claim ${result.claim._id} as a third-party notification)` : ''),
      resourceType: 'ThirdPartyClaim',
      resourceId: result.thirdPartyClaim._id,
      statusCode: 201,
      success: true,
      changes: { old: null, new: { reference: result.thirdPartyClaim.referenceNumber, createdClaim: result.createdClaim } },
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

/** Register a third-party claimant on an accident already on file. */
const registerThirdPartyClaim = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const tpc = await thirdPartyClaimService.register(
      { ...req.body, claim: req.params.claimId || req.body.claim },
      req.user
    );

    if (!belongsToCompany(tpc.company, company)) {
      return res.status(403).json({ message: 'That claim belongs to another insurer' });
    }

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription: `Registered third-party claim ${tpc.referenceNumber} (${tpc.claimType}) for ${tpc.party?.name}`,
      resourceType: 'ThirdPartyClaim',
      resourceId: tpc._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(thirdPartyClaimService.present(tpc.toObject()));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

/** Merge a third-party notification into the insured's later report. */
const mergeClaims = async (req, res) => {
  try {
    const { sourceClaim, targetClaim } = req.body;
    const result = await legalIntakeService.mergeClaims(sourceClaim, targetClaim, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Merged claim ${sourceClaim} into ${targetClaim} (${result.thirdPartyClaimsMoved} exposures moved)`,
      resourceType: 'Claim',
      resourceId: targetClaim,
      statusCode: 200,
      success: true,
      changes: { old: { claim: sourceClaim }, new: { mergedInto: targetClaim } },
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// ── Register ─────────────────────────────────────────────────────────────────

const listThirdPartyClaims = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const result = await thirdPartyClaimService.list({ ...req.query, company });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getThirdPartyClaim = async (req, res) => {
  try {
    const { company } = await loadScoped(req);
    const tpc = await thirdPartyClaimService.getById(req.params.id);
    res.status(200).json(tpc);
  } catch (error) {
    res.status(error.statusCode || 404).json({ message: error.message });
  }
};

const updateThirdPartyClaim = async (req, res) => {
  try {
    await loadScoped(req);
    const tpc = await thirdPartyClaimService.update(req.params.id, { ...req.body }, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Updated third-party claim ${tpc.referenceNumber}`,
      resourceType: 'ThirdPartyClaim',
      resourceId: tpc._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(thirdPartyClaimService.present(tpc.toObject()));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// ── Assessment ───────────────────────────────────────────────────────────────

/**
 * Record the liability apportionment — one of the two numbers driving every
 * downstream figure, so it is audited with before/after values.
 */
const assessLiability = async (req, res) => {
  try {
    await loadScoped(req);
    const { tpc, before, after } = await thirdPartyClaimService.assessLiability(
      req.params.id,
      req.body,
      req.user
    );

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Assessed liability on ${tpc.referenceNumber}: insured ${after.insuredSharePercent}%` +
        (after.contributoryPercent ? `, contributory ${after.contributoryPercent}%` : '') +
        (after.disputed ? ' (disputed)' : ''),
      resourceType: 'ThirdPartyClaim',
      resourceId: tpc._id,
      statusCode: 200,
      success: true,
      changes: { old: before, new: after },
    });

    res.status(200).json(thirdPartyClaimService.present(tpc.toObject()));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

/** Record the quantum assessment — what the claim is worth, broken down. */
const assessQuantum = async (req, res) => {
  try {
    await loadScoped(req);
    const { tpc, before, after } = await thirdPartyClaimService.assessQuantum(
      req.params.id,
      req.body,
      req.user
    );

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Assessed quantum on ${tpc.referenceNumber}: ${money.formatMinor(tpc.exposure?.grossMinor || 0)} gross, ` +
        `${money.formatMinor(tpc.exposure?.cappedMinor || 0)} exposure`,
      resourceType: 'ThirdPartyClaim',
      resourceId: tpc._id,
      statusCode: 200,
      success: true,
      changes: { old: before, new: after },
    });

    res.status(200).json(thirdPartyClaimService.present(tpc.toObject()));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

/**
 * Set or revise the reserve. The movement posts to the ledger; the field on the
 * document is only a cached head.
 */
const setReserve = async (req, res) => {
  try {
    await loadScoped(req);
    const beforeDoc = await ThirdPartyClaim.findById(req.params.id).select('reserve').lean();
    const tpc = await thirdPartyClaimService.setReserve(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Reserve on ${tpc.referenceNumber}: ${money.formatMinor(beforeDoc?.reserve?.currentMinor || 0)} → ` +
        `${money.formatMinor(tpc.reserve.currentMinor)}` +
        (tpc.reserve.overridden ? ' (outside schedule)' : ''),
      resourceType: 'ThirdPartyClaim',
      resourceId: tpc._id,
      statusCode: 200,
      success: true,
      changes: { old: beforeDoc?.reserve || null, new: tpc.reserve },
    });

    res.status(200).json(thirdPartyClaimService.present(tpc.toObject()));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// ── Exposure ─────────────────────────────────────────────────────────────────

const getExposure = async (req, res) => {
  try {
    const { tpc } = await loadScoped(req);
    const full = await ThirdPartyClaim.findById(req.params.id);
    const exposure = await thirdPartyClaimService.recomputeExposure(full);
    await full.save();
    res.status(200).json(require('../service/legalExposure.service').presentExposure(exposure));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

/**
 * Aggregate exposure across every claimant on one accident, against the policy's
 * aggregate limit. A per-claimant view can look comfortable while the accident
 * as a whole has exhausted cover.
 */
const getAccidentExposure = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const Claim = require('../models/claim.model');
    const claim = await Claim.findById(req.params.claimId).select('company').lean();
    if (!claim || !belongsToCompany(claim.company, company)) {
      return res.status(404).json({ message: 'Claim not found' });
    }
    const result = await thirdPartyClaimService.accidentExposure(req.params.claimId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// ── Limitation ───────────────────────────────────────────────────────────────

/**
 * The time-bar register — open claims ordered by how soon they expire. The first
 * screen the legal team should look at each morning.
 */
const getTimeBarRegister = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const claims = await limitationService.register({
      company,
      withinDays: req.query.within ? Number(req.query.within) : null,
      includeExpired: req.query.includeExpired !== 'false',
    });
    res.status(200).json({
      total: claims.length,
      expired: claims.filter((c) => c.expired).length,
      within30Days: claims.filter((c) => !c.expired && c.daysRemaining <= 30).length,
      items: claims,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Extend a limitation period — acknowledgement of liability or a part payment
 * can restart the clock. Always reasoned: a wrongly extended clock is worse than
 * none, because it reads as safe.
 */
const extendLimitation = async (req, res) => {
  try {
    const { tpc: scoped } = await loadScoped(req);
    const tpc = await limitationService.extendLimitation(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Extended limitation on ${tpc.referenceNumber} to ` +
        `${new Date(tpc.limitation.extendedTo).toISOString().slice(0, 10)} — ${req.body.reason}`,
      resourceType: 'ThirdPartyClaim',
      resourceId: tpc._id,
      statusCode: 200,
      success: true,
      changes: { old: { expiresAt: tpc.limitation.expiresAt }, new: { extendedTo: tpc.limitation.extendedTo } },
    });

    res.status(200).json(thirdPartyClaimService.present(tpc.toObject()));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// ── Financials ───────────────────────────────────────────────────────────────

const getFinancials = async (req, res) => {
  try {
    await loadScoped(req);
    const [position, entries] = await Promise.all([
      legalLedger.position({ thirdPartyClaim: req.params.id }),
      legalLedger.entries({ thirdPartyClaim: req.params.id }, { limit: 200 }),
    ]);
    res.status(200).json({
      position: {
        ...position,
        netExposure: money.toMajor(position.netExposureMinor),
        reserveTotal: money.toMajor(position.reserveTotalMinor),
        formatted: {
          netExposure: money.formatMinor(position.netExposureMinor),
          reserveTotal: money.formatMinor(position.reserveTotalMinor),
        },
      },
      entries,
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// ── Dashboard ────────────────────────────────────────────────────────────────

/**
 * The Legal dashboard's KPI set (spec §4), scoped to the caller's tenant.
 */
const getDashboard = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 86400000);
    const in30 = new Date(now.getTime() + 30 * 86400000);

    const base = company ? { company } : {};
    const open = { ...base, status: { $nin: ['settled', 'paid', 'closed', 'time_barred'] } };

    const LegalEvent = require('../models/legalEvent.model');

    const [
      openClaims, litigated, timeBarred,
      dueThisWeek, overdue, expiringSoon,
      position,
    ] = await Promise.all([
      ThirdPartyClaim.countDocuments(open),
      ThirdPartyClaim.countDocuments({ ...base, legalCase: { $ne: null } }),
      ThirdPartyClaim.countDocuments({ ...base, status: 'time_barred' }),
      LegalEvent.countDocuments({ ...base, status: { $in: ['scheduled', 'pending'] }, dueAt: { $gte: now, $lte: in7 } }),
      LegalEvent.countDocuments({ ...base, status: { $in: ['scheduled', 'pending', 'missed'] }, dueAt: { $lt: now } }),
      ThirdPartyClaim.countDocuments({ ...open, 'limitation.expiresAt': { $gte: now, $lte: in30 } }),
      company ? legalLedger.position({ company }) : Promise.resolve(null),
    ]);

    res.status(200).json({
      openThirdPartyClaims: openClaims,
      underLitigation: litigated,
      timeBarred,
      eventsDueThisWeek: dueThisWeek,
      overdueActions: overdue,
      timeBarsWithin30Days: expiringSoon,
      totalExposureMinor: position?.netExposureMinor ?? null,
      totalExposure: position ? money.toMajor(position.netExposureMinor) : null,
      totalReserveMinor: position?.reserveTotalMinor ?? null,
      totalReserve: position ? money.toMajor(position.reserveTotalMinor) : null,
      legalFeesMinor: position?.legalCostsMinor ?? null,
      recoveriesMinor: position?.recoveriesMinor ?? null,
      formatted: position
        ? {
            totalExposure: money.formatMinor(position.netExposureMinor),
            totalReserve: money.formatMinor(position.reserveTotalMinor),
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Config ───────────────────────────────────────────────────────────────────

const getConfig = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    if (!company) return res.status(400).json({ message: 'No tenant on this account' });
    res.status(200).json(await legalConfigService.get(company));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateConfig = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    if (!company) return res.status(400).json({ message: 'No tenant on this account' });

    const before = await legalConfigService.get(company);
    const config = await legalConfigService.update(company, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Updated legal configuration to version ${config.version}`,
      resourceType: 'LegalConfig',
      resourceId: config._id,
      statusCode: 200,
      success: true,
      changes: { old: { version: before.version }, new: { version: config.version } },
    });

    res.status(200).json(config);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

module.exports = {
  matchDemand,
  recordDemand,
  registerThirdPartyClaim,
  mergeClaims,
  listThirdPartyClaims,
  getThirdPartyClaim,
  updateThirdPartyClaim,
  assessLiability,
  assessQuantum,
  setReserve,
  getExposure,
  getAccidentExposure,
  getTimeBarRegister,
  extendLimitation,
  getFinancials,
  getDashboard,
  getConfig,
  updateConfig,
};
