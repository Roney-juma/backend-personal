const ApprovalRequest = require('../models/approvalRequest.model');
const Role = require('../models/roles.model');
const User = require('../models/users.model');
const legalConfig = require('./legalConfig.service');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');

/**
 * The authority engine.
 *
 * Routes a monetary decision to whoever the tenant's authority matrix says may
 * take it, records the decision, and — the part that matters years later —
 * snapshots the matrix rule that was applied.
 *
 * Deliberately generic (`subjectType` + `subjectId`): settlements, payment
 * requests, counsel appointments and reserve overrides all need the same
 * request → decision → escalation shape, and other modules can adopt it without
 * a second implementation.
 *
 * Distinct from the DEADLINE escalation chain in legalReminder.service. That one
 * decides who gets woken when a date is missed; this one decides who may sign
 * off an amount. A tenant may escalate a missed deadline to the GM without the
 * GM holding any settlement authority at all.
 */

// A role normalising to admin/superadmin is unrestricted — mirrors
// requirePermission.js so both sides agree on who is unlimited.
const isAdminRole = (roleName) => {
  const n = String(roleName || '').toLowerCase().replace(/[\s_-]/g, '');
  return n === 'admin' || n === 'superadmin';
};

/**
 * Raise a request for authority.
 *
 * @param {Object} params
 * @param {*}      params.company
 * @param {string} params.subjectType   'Settlement' | 'PaymentRequest' | …
 * @param {*}      params.subjectId
 * @param {number} params.amountMinor
 * @param {string} [params.summary]
 * @param {Object} [actor]
 * @returns {Promise<Object>} the ApprovalRequest
 */
async function createRequest(params, actor = null) {
  const { company, subjectType, subjectId, amountMinor } = params;

  if (!company || !subjectType || !subjectId) {
    throw new ApiError(400, 'An approval request needs a company, subject type and subject');
  }
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new ApiError(400, 'An approval request needs a whole, non-negative amount');
  }

  // Supersede any live request on the same subject — a revised settlement must
  // not leave an approvable request for the old figure sitting in the queue.
  await ApprovalRequest.updateMany(
    { subjectType, subjectId, status: { $in: ['pending', 'escalated'] } },
    { $set: { status: 'withdrawn', decidedAt: new Date() } }
  );

  const band = await legalConfig.authorityFor(company, amountMinor);
  if (!band) {
    throw new ApiError(
      500,
      'No settlement authority matrix is configured for this insurer — set one before proposing settlements'
    );
  }

  const request = await ApprovalRequest.create({
    company,
    subjectType,
    subjectId,
    claim: params.claim,
    thirdPartyClaim: params.thirdPartyClaim,
    legalCase: params.legalCase,
    summary: params.summary,
    amountMinor,
    currency: params.currency || 'KES',

    // The point of the whole record. Two years on, when the matrix has been
    // edited three times and a settlement is questioned, this proves which
    // policy was in force on the day — a live lookup cannot.
    matrixRuleSnapshot: {
      minMinor: band.minMinor,
      maxMinor: band.maxMinor,
      approverKind: band.approverKind,
      approver: band.approver,
      configVersion: band.configVersion,
      snapshotAt: new Date(),
    },

    requiredApprover: band.approver,
    requiredApproverKind: band.approverKind,
    requestedBy: actor?._id || actor?.id || null,
    requestedByName: actor?.fullName || actor?.name || 'System',
    justification: params.justification,
    status: 'pending',
    dueBy: params.dueBy,
  });

  if (band.outsideMatrix) {
    logger.warn(
      `[approval] ${money.formatMinor(amountMinor)} fell outside company ${company}'s authority matrix — ` +
      `routed to the highest configured approver (${band.approver})`
    );
  }

  logger.info(
    `[approval] ${subjectType} ${subjectId} — ${money.formatMinor(amountMinor)} requires ${band.approver}`
  );

  // Tell whoever has to sign this off. An approval nobody was told about is the
  // commonest reason a settlement sits untouched past the date it was needed.
  notifyApprover(request, band).catch((err) =>
    logger.error(`[approval] could not notify approver of ${request._id}: ${err.message}`)
  );

  return request;
}

/**
 * Notify the required approver that something is waiting on them.
 *
 * Fire-and-forget: a notification failure must never roll back a validly
 * created approval request. The record is the source of truth; the message is
 * a prompt.
 */
async function notifyApprover(request, band) {
  const notify = require('./legalNotify.service');
  const msg = notify.templates.approvalRequired({
    reference: request.summary || `${request.subjectType} ${request.subjectId}`,
    amount: money.formatMinor(request.amountMinor),
    party: request.summary,
    approver: request.requiredApprover,
    reserve: band?.outsideMatrix
      ? 'This amount is above every configured band and was routed to the highest approver.'
      : null,
  });

  if (request.requiredApproverKind === 'user') {
    return notify.sendToUser({
      userId: request.requiredApprover,
      type: 'legal_approval_required',
      title: msg.title,
      body: msg.body,
      claimId: request.claim,
    });
  }

  // A permission band names a permission rather than a role, so expand it to
  // whichever roles in this tenant currently carry it. Doing that here means an
  // insurer can rename or split roles without silently muting approvals.
  let roles = [request.requiredApprover];
  if (request.requiredApproverKind === 'permission') {
    const holders = await Role.find({
      company: request.company,
      permissions: request.requiredApprover,
    })
      .select('name')
      .lean();
    if (!holders.length) {
      logger.warn(
        `[approval] no role in company ${request.company} holds ${request.requiredApprover} — ` +
        `nobody was notified about ${money.formatMinor(request.amountMinor)}`
      );
      return { notified: 0 };
    }
    roles = holders.map((r) => r.name);
  }

  return notify.sendToRoles({
    company: request.company,
    roles,
    type: 'legal_approval_required',
    title: msg.title,
    body: msg.body,
    claimId: request.claim,
  });
}

/**
 * May this actor decide this request?
 *
 * Checked here rather than only in middleware because the authority matrix is
 * DATA: holding APPROVE_SETTLEMENT lets you approve settlements in general, but
 * the matrix decides which amounts. A Claims Manager with the permission still
 * cannot sign off a figure reserved for the CEO.
 *
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
async function canDecide(request, actor) {
  if (!actor) return { allowed: false, reason: 'Not authenticated' };

  const roleName = actor.roleName || actor.role?.name || null;
  if (isAdminRole(roleName)) return { allowed: true };

  // Nobody signs off their own proposal, whatever authority they hold.
  const actorId = String(actor._id || actor.id || '');
  if (actorId && String(request.requestedBy || '') === actorId) {
    return {
      allowed: false,
      reason: 'A settlement cannot be approved by the person who proposed it',
    };
  }

  const { requiredApproverKind, requiredApprover } = request;

  if (requiredApproverKind === 'user') {
    return String(requiredApprover) === actorId
      ? { allowed: true }
      : { allowed: false, reason: 'This decision is reserved to a named approver' };
  }

  if (requiredApproverKind === 'permission') {
    const held = (actor.permissions || []).map((p) => String(p).toUpperCase());
    return held.includes(String(requiredApprover).toUpperCase())
      ? { allowed: true }
      : { allowed: false, reason: `Requires the ${requiredApprover} permission` };
  }

  // Default: role.
  const normalise = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
  if (normalise(roleName) === normalise(requiredApprover)) return { allowed: true };

  return {
    allowed: false,
    reason:
      `${money.formatMinor(request.amountMinor)} requires ${requiredApprover}; ` +
      `you are signed in as ${roleName || 'a role with no name'}`,
  };
}

/**
 * Record a decision.
 *
 * @param {*} requestId
 * @param {'approved'|'rejected'} decision
 * @param {string} [notes]
 * @param {Object} actor
 */
async function decide(requestId, decision, notes, actor, req = null) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ApiError(400, `Unknown decision: ${decision}`);
  }

  const request = await ApprovalRequest.findById(requestId);
  if (!request) throw new ApiError(404, 'Approval request not found');
  if (!['pending', 'escalated'].includes(request.status)) {
    throw new ApiError(409, `That request is already ${request.status}`);
  }
  if (decision === 'rejected' && !String(notes || '').trim()) {
    throw new ApiError(400, 'A rejection needs a reason');
  }

  const { allowed, reason } = await canDecide(request, actor);
  if (!allowed) throw new ApiError(403, reason);

  request.decisions.push({
    approver: actor._id || actor.id,
    approverName: actor.fullName || actor.name,
    approverRole: actor.roleName || null,
    decision,
    notes,
    at: new Date(),
    ipAddress: req?.ip,
  });
  request.status = decision;
  request.decidedAt = new Date();
  await request.save();

  logger.info(
    `[approval] ${request.subjectType} ${request.subjectId} ${decision} by ` +
    `${actor.fullName || actor.id} (${money.formatMinor(request.amountMinor)})`
  );

  // The officer who proposed it needs to know either way — an approval nobody
  // acts on is as costly as one nobody granted.
  if (request.requestedBy) {
    const notify = require('./legalNotify.service');
    const msg = notify.templates.approvalDecided({
      reference: request.summary || `${request.subjectType} ${request.subjectId}`,
      decision,
      amount: money.formatMinor(request.amountMinor),
      by: actor.fullName || actor.name || 'an approver',
      notes,
    });
    notify
      .sendToUser({
        userId: request.requestedBy,
        type: 'legal_approval_decided',
        title: msg.title,
        body: msg.body,
        claimId: request.claim,
      })
      .catch((err) => logger.error(`[approval] decision notice failed: ${err.message}`));
  }

  return request;
}

/**
 * Push a request up to the next authority band.
 *
 * Used when the approver declines to decide alone rather than rejecting — a
 * genuine and common outcome on a borderline figure. The escalated request keeps
 * its history and gains a new snapshot for the band now responsible.
 */
async function escalate(requestId, notes, actor) {
  const request = await ApprovalRequest.findById(requestId);
  if (!request) throw new ApiError(404, 'Approval request not found');
  if (!['pending', 'escalated'].includes(request.status)) {
    throw new ApiError(409, `That request is already ${request.status}`);
  }

  const config = await legalConfig.get(request.company);
  const bands = config.authorityMatrix || [];
  const currentIndex = bands.findIndex((b) => b.approver === request.requiredApprover);
  const next = bands[currentIndex + 1];

  if (!next) {
    throw new ApiError(
      409,
      `${request.requiredApprover} is the highest authority configured — there is nobody above to escalate to`
    );
  }

  request.decisions.push({
    approver: actor?._id || actor?.id,
    approverName: actor?.fullName || actor?.name,
    approverRole: actor?.roleName || null,
    decision: 'escalated',
    notes,
    at: new Date(),
  });

  request.escalatedFrom = request.requiredApprover;
  request.escalatedAt = new Date();
  request.requiredApprover = next.approver;
  request.requiredApproverKind = next.approverKind;
  // Re-snapshot: the rule now governing the decision is the one that must be
  // provable later, and it is a different rule from the original.
  request.matrixRuleSnapshot = {
    minMinor: next.minMinor,
    maxMinor: next.maxMinor,
    approverKind: next.approverKind,
    approver: next.approver,
    configVersion: config.version,
    snapshotAt: new Date(),
  };
  request.status = 'escalated';
  await request.save();

  logger.info(
    `[approval] ${request.subjectType} ${request.subjectId} escalated ` +
    `${request.escalatedFrom} → ${next.approver}`
  );

  // The new approver inherits the decision, so they inherit the notification.
  notifyApprover(request, next).catch((err) =>
    logger.error(`[approval] could not notify escalated approver: ${err.message}`)
  );

  return request;
}

/**
 * The approval queue.
 *
 * When `forActor` is given, returns only what that person can actually decide —
 * a queue full of items you are not authorised to touch is noise, and teaches
 * people to ignore the queue.
 */
async function listPending({ company, subjectType, forActor = null, limit = 100 }) {
  const filter = { company, status: { $in: ['pending', 'escalated'] } };
  if (subjectType) filter.subjectType = subjectType;

  const requests = await ApprovalRequest.find(filter)
    .sort({ requestedAt: 1 })
    .limit(limit)
    .populate('thirdPartyClaim', 'referenceNumber party claimType exposure')
    .lean();

  if (!forActor) return requests;

  const decorated = [];
  for (const request of requests) {
    const { allowed, reason } = await canDecide(request, forActor);
    decorated.push({ ...request, canDecide: allowed, blockedReason: allowed ? null : reason });
  }
  return decorated;
}

/**
 * The live request for a subject, if any.
 */
async function findForSubject(subjectType, subjectId) {
  return ApprovalRequest.findOne({
    subjectType,
    subjectId,
    status: { $in: ['pending', 'escalated'] },
  }).lean();
}

/**
 * Which role would have to approve this amount, without raising a request.
 * Lets the UI tell a proposer who they are about to send it to.
 */
async function previewAuthority(company, amountMinor) {
  const band = await legalConfig.authorityFor(company, amountMinor);
  if (!band) return null;
  return {
    approver: band.approver,
    approverKind: band.approverKind,
    bandMinMinor: band.minMinor,
    bandMaxMinor: band.maxMinor,
    outsideMatrix: Boolean(band.outsideMatrix),
  };
}

module.exports = {
  createRequest,
  canDecide,
  decide,
  escalate,
  listPending,
  findForSubject,
  previewAuthority,
};
