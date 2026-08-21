const referralService = require('../service/legalReferral.service');
const LegalReferral = require('../models/legalReferral.model');
const Claim = require('../models/claim.model');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');
const ApiError = require('../utils/ApiError');

/**
 * Referral — the route by which an existing claim reaches Legal.
 *
 * Raising is a claims-side action (CREATE_LEGAL_REFERRAL); deciding is a
 * legal-side one (APPROVE_LEGAL_REFERRAL). Keeping them on separate permissions
 * is what makes the referral a request rather than an instruction.
 */

const handle = (res, error) => res.status(error.statusCode || 400).json({ message: error.message });

async function scoped(req) {
  const company = await getRequesterCompany(req);
  const referral = await LegalReferral.findById(req.params.id).select('company reference claim status');
  if (!referral) throw new ApiError(404, 'Referral not found');
  if (!belongsToCompany(referral.company, company)) throw new ApiError(404, 'Referral not found');
  return { referral, company };
}

const raise = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const claim = await Claim.findById(req.body.claim || req.params.claimId).select('company').lean();
    if (!claim || !belongsToCompany(claim.company, company)) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    const referral = await referralService.raise(
      { ...req.body, claim: req.body.claim || req.params.claimId },
      req.user
    );

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Referred claim to Legal — ${referral.reference} (${referral.reason}, ${referral.urgency}): ` +
        referral.legalIssue,
      resourceType: 'LegalReferral',
      resourceId: referral._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(referral);
  } catch (error) {
    handle(res, error);
  }
};

const list = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await referralService.list({ ...req.query, company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getById = async (req, res) => {
  try {
    await scoped(req);
    res.status(200).json(await referralService.getById(req.params.id));
  } catch (error) {
    handle(res, error);
  }
};

/** Accept into Legal. This is what formally marks the claim as a legal matter. */
const accept = async (req, res) => {
  try {
    await scoped(req);
    const referral = await referralService.accept(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Accepted referral ${referral.reference} into Legal`,
      resourceType: 'LegalReferral',
      resourceId: referral._id,
      statusCode: 200,
      success: true,
      changes: { old: { status: 'pending' }, new: { status: 'accepted' } },
    });

    res.status(200).json(referral);
  } catch (error) {
    handle(res, error);
  }
};

const returnToClaims = async (req, res) => {
  try {
    await scoped(req);
    const referral = await referralService.returnToClaims(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Returned referral ${referral.reference} to claims — ${req.body.notes}`,
      resourceType: 'LegalReferral',
      resourceId: referral._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(referral);
  } catch (error) {
    handle(res, error);
  }
};

const withdraw = async (req, res) => {
  try {
    await scoped(req);
    res.status(200).json(await referralService.withdraw(req.params.id, req.user));
  } catch (error) {
    handle(res, error);
  }
};

/**
 * Evaluate one claim against the tenant's triggers without acting — lets a user
 * see why a claim would (or would not) be referred before turning triggers on.
 */
const evaluateClaim = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const claim = await Claim.findById(req.params.claimId).select('company').lean();
    if (!claim || !belongsToCompany(claim.company, company)) {
      return res.status(404).json({ message: 'Claim not found' });
    }
    res.status(200).json(await referralService.evaluate(req.params.claimId, { autoRaise: false }));
  } catch (error) {
    handle(res, error);
  }
};

/** The trigger catalogue, so the config UI can offer them by name. */
const availableTriggers = async (_req, res) => {
  res.status(200).json({
    triggers: Object.keys(referralService.TRIGGERS).map((code) => ({
      code,
      label: code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    })),
  });
};

module.exports = {
  raise,
  list,
  getById,
  accept,
  returnToClaims,
  withdraw,
  evaluateClaim,
  availableTriggers,
};
