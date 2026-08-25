const LegalEvent = require('../models/legalEvent.model');
const LegalCase = require('../models/legalCase.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const legalConfig = require('./legalConfig.service');
const { EVENT_KINDS } = require('../constants/legal.constants');

/**
 * The court diary.
 *
 * Per spec §9 this is one of the two screens users live in. It runs on the same
 * LegalEvent stream as statutory time-bars, which is deliberate: a limitation
 * date and a mention are both "something must happen by this date", and giving
 * them separate machinery is how one of them ends up unwatched.
 */

/**
 * Create a diary entry.
 *
 * `eventType` is validated against the TENANT's configured list rather than a
 * schema enum, because legal officers add their own deadline types — taxation
 * of costs, mediation, statutory notices — and the reminder ladder must apply to
 * those identically.
 */
async function createEvent(data, actor = null, { source = 'legal_officer' } = {}) {
  if (!data.dueAt) throw new ApiError(400, 'A diary entry needs a due date');
  if (!data.title) throw new ApiError(400, 'A diary entry needs a title');

  let company = data.company;
  let claim = data.claim;

  if (data.legalCase) {
    const legalCase = await LegalCase.findById(data.legalCase).select('company claim court courtStation').lean();
    if (!legalCase) throw new ApiError(404, 'Legal case not found');
    company = legalCase.company;
    claim = legalCase.claim;
    data.court = data.court || legalCase.court;
    data.courtStation = data.courtStation || legalCase.courtStation;
  }

  if (!company) throw new ApiError(400, 'A diary entry must be scoped to an insurer');

  const config = await legalConfig.get(company);
  const known = (config.eventTypes || []).find((t) => t.code === data.eventType);

  // Unknown types are allowed but flagged: blocking would stop a legal officer
  // recording a real deadline because an admin had not added it to a list yet,
  // and a missed deadline is far worse than an unclassified one.
  if (!known && data.eventType) {
    logger.info(
      `[legal-diary] event type '${data.eventType}' is not in company ${company}'s configured list — ` +
      'recorded anyway'
    );
  }

  const kind = data.kind || known?.kind || EVENT_KINDS.TASK;
  const reminderOffsets =
    data.reminderOffsets ||
    known?.reminderOffsets ||
    config.reminderOffsets ||
    [30, 14, 7, 2, 0];

  const event = await LegalEvent.create({
    company,
    legalCase: data.legalCase,
    thirdPartyClaim: data.thirdPartyClaim,
    claim,
    kind,
    eventType: data.eventType || 'task',
    title: data.title,
    description: data.description,
    dueAt: new Date(data.dueAt),
    allDay: data.allDay !== false,
    court: data.court,
    courtStation: data.courtStation,
    responsibleType: data.responsibleType || 'Role',
    responsible: data.responsible,
    responsibleRole: data.responsibleRole || (data.responsible ? undefined : 'Legal Officer'),
    // Resolved at creation, so changing the tenant ladder later does not
    // retroactively rewrite what an in-flight event promised.
    reminderOffsets,
    status: 'scheduled',
    source,
    createdBy: actor?._id || actor?.id || null,
  });

  await refreshNextAction(data.legalCase);
  return event;
}

/**
 * Adjourn: close this entry and create its successor.
 *
 * NOT a date change. Matters are adjourned constantly, and moving `dueAt` in
 * place erases the history that advocate-performance and court-performance
 * reporting depend on — "this court adjourned us four times" is exactly the
 * insight the module exists to surface, and it is invisible if each adjournment
 * overwrites the last.
 */
async function adjourn(eventId, { newDate, reason, outcome }, actor = null) {
  if (!newDate) throw new ApiError(400, 'An adjournment needs the new date');

  const event = await LegalEvent.findById(eventId);
  if (!event) throw new ApiError(404, 'Diary entry not found');
  if (['done', 'cancelled'].includes(event.status)) {
    throw new ApiError(409, `That entry is already ${event.status} and cannot be adjourned`);
  }

  event.status = 'adjourned';
  event.outcome = outcome || reason || 'Adjourned';
  event.adjournmentReason = reason;
  await event.save();

  const successor = await LegalEvent.create({
    company: event.company,
    legalCase: event.legalCase,
    thirdPartyClaim: event.thirdPartyClaim,
    claim: event.claim,
    kind: event.kind,
    eventType: event.eventType,
    title: event.title,
    description: event.description,
    dueAt: new Date(newDate),
    allDay: event.allDay,
    court: event.court,
    courtStation: event.courtStation,
    responsibleType: event.responsibleType,
    responsible: event.responsible,
    responsibleRole: event.responsibleRole,
    reminderOffsets: event.reminderOffsets,
    status: 'scheduled',
    adjournedFrom: event._id,
    source: actor?.accountType === 'Advocate' ? 'advocate_portal' : 'legal_officer',
    createdBy: actor?._id || actor?.id || null,
  });

  event.adjournedTo = successor._id;
  await event.save();

  await refreshNextAction(event.legalCase);

  logger.info(
    `[legal-diary] ${event.eventType} on ${event.legalCase || event.thirdPartyClaim} adjourned ` +
    `${event.dueAt.toISOString().slice(0, 10)} → ${new Date(newDate).toISOString().slice(0, 10)}`
  );
  return { adjourned: event, successor };
}

async function completeEvent(eventId, { outcome }, actor = null) {
  const event = await LegalEvent.findById(eventId);
  if (!event) throw new ApiError(404, 'Diary entry not found');

  event.status = 'done';
  event.outcome = outcome;
  event.completedAt = new Date();
  event.completedBy = actor?._id || actor?.id || null;
  await event.save();

  await refreshNextAction(event.legalCase);
  return event;
}

async function cancelEvent(eventId, reason, actor = null) {
  const event = await LegalEvent.findById(eventId);
  if (!event) throw new ApiError(404, 'Diary entry not found');

  // A statutory clock is not ours to cancel — it expires whether or not we
  // acknowledge it. Extending it is a separate, reasoned act.
  if (event.kind === EVENT_KINDS.LIMITATION) {
    throw new ApiError(
      409,
      'A statutory limitation entry cannot be cancelled. Extend the limitation period instead if it has moved.'
    );
  }

  event.status = 'cancelled';
  event.outcome = reason;
  await event.save();
  await refreshNextAction(event.legalCase);
  return event;
}

/**
 * Keep the case's cached "what's next" pointer honest, so case lists can show it
 * without joining the diary on every row.
 */
async function refreshNextAction(caseId) {
  if (!caseId) return null;
  try {
    const next = await LegalEvent.findOne({
      legalCase: caseId,
      status: { $in: ['scheduled', 'pending'] },
      dueAt: { $gte: new Date() },
    })
      .sort({ dueAt: 1 })
      .lean();

    await LegalCase.updateOne(
      { _id: caseId },
      {
        $set: {
          nextActionAt: next?.dueAt || null,
          nextActionLabel: next?.title || null,
          nextEventId: next?._id || null,
        },
      }
    );
    return next;
  } catch (err) {
    logger.warn(`[legal-diary] next-action refresh failed for case ${caseId}: ${err.message}`);
    return null;
  }
}

/**
 * The cross-case diary.
 *
 * Overdue entries are returned regardless of the requested window: something
 * that should have happened last week is more urgent than anything scheduled
 * for next, and filtering it out of a date range is how it stays missed.
 */
async function diary({ company, from, to, status, responsible, court, kind, includeOverdue = true }) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(Date.now() + 30 * 86400000);

  const base = { company };
  if (responsible) base.responsible = responsible;
  if (court) base.court = court;
  if (kind) base.kind = kind;
  if (status) base.status = Array.isArray(status) ? { $in: status } : status;

  const windowed = await LegalEvent.find({ ...base, dueAt: { $gte: start, $lte: end } })
    .sort({ dueAt: 1 })
    .limit(500)
    .populate('legalCase', 'caseNumber courtCaseNumber court')
    .lean();

  // A query string carries "false" as a string, which is truthy — so the flag
  // silently never turned anything off for an HTTP caller.
  const wantOverdue = includeOverdue !== false && includeOverdue !== 'false';

  let overdue = [];
  if (wantOverdue) {
    overdue = await LegalEvent.find({
      ...base,
      status: { $in: ['scheduled', 'pending', 'missed'] },
      dueAt: { $lt: new Date() },
    })
      .sort({ dueAt: 1 })
      .limit(200)
      .populate('legalCase', 'caseNumber courtCaseNumber court')
      .lean();
  }

  const decorate = (e) => ({
    ...e,
    daysUntil: Math.ceil((new Date(e.dueAt).getTime() - Date.now()) / 86400000),
    isOverdue: new Date(e.dueAt) < new Date() && ['scheduled', 'pending', 'missed'].includes(e.status),
    isLimitation: e.kind === EVENT_KINDS.LIMITATION,
  });

  return {
    window: { from: start, to: end },
    overdue: overdue.map(decorate),
    upcoming: windowed.map(decorate),
    counts: {
      overdue: overdue.length,
      upcoming: windowed.length,
      limitations: windowed.filter((e) => e.kind === EVENT_KINDS.LIMITATION).length,
    },
  };
}

/**
 * One matter's diary, including adjournment history — closed and adjourned
 * entries are shown, because the pattern of adjournments IS the story.
 */
async function caseDiary(caseId) {
  const events = await LegalEvent.find({ legalCase: caseId })
    .sort({ dueAt: 1 })
    .lean();

  const adjournmentCount = events.filter((e) => e.status === 'adjourned').length;

  return {
    events,
    adjournmentCount,
    note:
      adjournmentCount >= 3
        ? `This matter has been adjourned ${adjournmentCount} times.`
        : null,
  };
}

module.exports = {
  createEvent,
  adjourn,
  completeEvent,
  cancelEvent,
  refreshNextAction,
  diary,
  caseDiary,
};
