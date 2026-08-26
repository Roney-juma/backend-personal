const settlementService = require('../service/settlement.service');
const approvalService = require('../service/approval.service');
const legalReportService = require('../service/legalReport.service');
const Settlement = require('../models/settlement.model');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');
const ApiError = require('../utils/ApiError');
const money = require('../utils/money');

/**
 * Settlements, approvals and management reports.
 *
 * Money decisions are audited with the amount in the description, not just the
 * record id — an audit trail you have to join three collections to read does not
 * get read.
 */

async function loadScoped(req) {
  const company = await getRequesterCompany(req);
  const settlement = await Settlement.findById(req.params.id).select('company reference status totalMinor');
  if (!settlement) throw new ApiError(404, 'Settlement not found');
  if (!belongsToCompany(settlement.company, company)) throw new ApiError(404, 'Settlement not found');
  return { settlement, company };
}

const handle = (res, error) =>
  res.status(error.statusCode || 400).json({ message: error.message });

// ── Settlements ──────────────────────────────────────────────────────────────

const list = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await settlementService.list({ ...req.query, company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getById = async (req, res) => {
  try {
    await loadScoped(req);
    res.status(200).json(await settlementService.getById(req.params.id));
  } catch (error) {
    handle(res, error);
  }
};

const propose = async (req, res) => {
  try {
    const settlement = await settlementService.propose(req.body, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Proposed settlement ${settlement.reference} at ${money.formatMinor(settlement.totalMinor)}`,
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

/** Record a move in the negotiation — ours or theirs. */
const addOffer = async (req, res) => {
  try {
    await loadScoped(req);
    const settlement = await settlementService.addOffer(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `${req.body.by === 'claimant' ? 'Claimant' : 'Insurer'} offer on ${settlement.reference}: ` +
        `${money.formatMinor(Number.isInteger(req.body.amountMinor) ? req.body.amountMinor : money.toMinor(req.body.amount))}`,
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

const submitForApproval = async (req, res) => {
  try {
    await loadScoped(req);
    const { settlement, approvalRequest } = await settlementService.submitForApproval(
      req.params.id,
      req.user
    );

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Sent ${settlement.reference} (${money.formatMinor(settlement.totalMinor)}) for approval by ` +
        `${approvalRequest.requiredApprover}`,
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json({ settlement, approvalRequest });
  } catch (error) {
    handle(res, error);
  }
};

/**
 * Approve or reject.
 *
 * Two gates, deliberately: the route checks APPROVE_SETTLEMENT (may you approve
 * settlements at all?) and the approval service checks the authority matrix (may
 * you approve THIS amount?). Holding the permission is not authority for every
 * figure.
 */
const decide = async (req, res) => {
  try {
    const { settlement } = await loadScoped(req);
    const { decision, notes } = req.body;

    const request = await approvalService.findForSubject('Settlement', req.params.id);
    if (!request) {
      return res.status(409).json({ message: 'That settlement is not awaiting approval' });
    }

    await approvalService.decide(request._id, decision, notes, req.user, req);
    const updated = await settlementService.applyDecision(req.params.id, decision, notes, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `${decision === 'approved' ? 'Approved' : 'Rejected'} settlement ${updated.reference} — ` +
        `${money.formatMinor(updated.totalMinor)}` + (notes ? ` (${notes})` : ''),
      resourceType: 'Settlement',
      resourceId: updated._id,
      statusCode: 200,
      success: true,
      changes: {
        old: { status: settlement.status },
        new: { status: updated.status, approvedAmountMinor: updated.approvedAmountMinor },
      },
    });

    res.status(200).json(updated);
  } catch (error) {
    handle(res, error);
  }
};

/** Pass the decision up to the next authority band. */
const escalate = async (req, res) => {
  try {
    await loadScoped(req);
    const request = await approvalService.findForSubject('Settlement', req.params.id);
    if (!request) return res.status(409).json({ message: 'That settlement is not awaiting approval' });

    const updated = await approvalService.escalate(request._id, req.body.notes, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Escalated approval from ${updated.escalatedFrom} to ${updated.requiredApprover}`,
      resourceType: 'ApprovalRequest',
      resourceId: updated._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(updated);
  } catch (error) {
    handle(res, error);
  }
};

const recordClaimantResponse = async (req, res) => {
  try {
    await loadScoped(req);
    const settlement = await settlementService.recordClaimantResponse(
      req.params.id,
      req.body,
      req.user
    );

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Claimant ${req.body.accepted ? 'accepted' : 'declined'} settlement ${settlement.reference}`,
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

const execute = async (req, res) => {
  try {
    await loadScoped(req);
    const settlement = await settlementService.execute(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Executed settlement ${settlement.reference} — ${money.formatMinor(settlement.totalMinor)} ` +
        'posted to the legal ledger',
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

const requestPayment = async (req, res) => {
  try {
    await loadScoped(req);
    const settlement = await settlementService.requestPayment(req.params.id, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Requested payment of ${settlement.reference} from Finance`,
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

const markPaid = async (req, res) => {
  try {
    await loadScoped(req);
    const settlement = await settlementService.markPaid(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Paid settlement ${settlement.reference} — ${money.formatMinor(settlement.totalMinor)}` +
        (settlement.paymentReference ? ` (ref ${settlement.paymentReference})` : ''),
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

const withdraw = async (req, res) => {
  try {
    await loadScoped(req);
    const settlement = await settlementService.withdraw(req.params.id, req.body.reason, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription: `Withdrew settlement ${settlement.reference} — ${req.body.reason}`,
      resourceType: 'Settlement',
      resourceId: settlement._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(settlement);
  } catch (error) {
    handle(res, error);
  }
};

// ── Approvals ────────────────────────────────────────────────────────────────

/**
 * The approval queue, annotated with whether the caller can actually decide each
 * item — a queue full of things you may not touch teaches people to ignore it.
 */
const listApprovals = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const items = await approvalService.listPending({
      company,
      subjectType: req.query.subjectType,
      forActor: req.user,
    });
    res.status(200).json({
      total: items.length,
      actionable: items.filter((i) => i.canDecide).length,
      items,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Who would have to approve this amount? Lets the UI say so before submitting. */
const previewAuthority = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const amountMinor = Number.isInteger(Number(req.query.amountMinor))
      ? Number(req.query.amountMinor)
      : money.toMinor(req.query.amount);
    res.status(200).json(await approvalService.previewAuthority(company, amountMinor));
  } catch (error) {
    handle(res, error);
  }
};

// ── Reports ──────────────────────────────────────────────────────────────────

const monthlyReport = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalReportService.monthly({ company, ...req.query }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const closurePipelineReport = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalReportService.closurePipeline({ company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const agingReport = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalReportService.aging({ company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const reservingAccuracyReport = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalReportService.reservingAccuracy({ company, ...req.query }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  list,
  getById,
  propose,
  addOffer,
  submitForApproval,
  decide,
  escalate,
  recordClaimantResponse,
  execute,
  requestPayment,
  markPaid,
  withdraw,
  listApprovals,
  previewAuthority,
  monthlyReport,
  agingReport,
  closurePipelineReport,
  reservingAccuracyReport,
};
