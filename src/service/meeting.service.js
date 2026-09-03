const mongoose = require('mongoose');
const Meeting = require('../models/meeting.model');
const Task = require('../models/task.model');
const notify = require('./workspaceNotify.service');
const logger = require('../middlewheres/logger');
const { formatDateTime } = require('../utils/timezone');

// Every model named in POPULATE must be registered before the first populate()
// runs, or mongoose throws MissingSchemaError. Requiring them here rather than
// relying on some route having loaded them first — note the registered name is
// 'ProviderUser', not 'providerUser'; refs are case-sensitive.
require('../models/providerUser.model');
require('../models/insuranceCompany.model');

const POPULATE = [
  { path: 'organiser', select: 'fullName email profilePictureUrl' },
  { path: 'attendees.user', select: 'fullName email profilePictureUrl' },
  { path: 'client.company', select: 'name email' },
];

/** Advance `date` by one recurrence step. Month steps clamp to end-of-month. */
const addInterval = (date, frequency, steps) => {
  const d = new Date(date);
  switch (frequency) {
    case 'daily':
      d.setDate(d.getDate() + steps);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7 * steps);
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14 * steps);
      break;
    case 'monthly': {
      const targetDay = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + steps);
      // A 31st in a 30-day month lands on the last day, not the 1st of the next.
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(targetDay, lastDay));
      break;
    }
    default:
      break;
  }
  return d;
};

const actorFields = (actor) => ({
  id: actor?.id ?? actor?._id ?? null,
  name: actor?.fullName ?? actor?.username ?? actor?.email ?? 'Unknown',
});

/**
 * Attach who the invitation is going to, so the caller can say so rather than
 * leaving the user guessing whether anything was sent. Resolving recipients is
 * pure in-memory work — the sending itself stays fire-and-forget.
 */
const withInviteSummary = (meeting, notified) => {
  const recipients = notified ? notify.recipientsOf(meeting) : [];
  return {
    ...meeting.toObject(),
    invited: {
      notified,
      count: recipients.length,
      recipients: recipients.map((r) => ({ name: r.name ?? null, email: r.email })),
    },
  };
};

/**
 * Create a meeting, expanding a recurrence rule into real occurrences.
 * Occurrences are saved one at a time (not insertMany) because the reference
 * counter lives in a pre-save hook, which insertMany bypasses.
 */
const create = async (data, actor) => {
  const who = actorFields(actor);
  // `notify` is a request flag, not a stored field — strip it before it reaches
  // the document.
  const { notify: shouldNotify = true, ...rest } = data;
  const base = {
    ...rest,
    organiser: rest.organiser ?? who.id,
    organiserName: rest.organiserName ?? who.name,
  };

  const frequency = base.recurrence?.frequency ?? 'none';
  const count = Math.min(Number(base.recurrence?.count ?? 1) || 1, 52);

  if (frequency === 'none' || count <= 1) {
    const meeting = new Meeting(base);
    await meeting.save();
    const populated = await Meeting.findById(meeting._id).populate(POPULATE);
    if (shouldNotify) {
      // Fire-and-forget: a mail outage must not fail the scheduling request.
      notify.meetingScheduled(populated).catch((err) =>
        logger.warn(`[meeting] invitation emails failed for ${populated.reference}: ${err.message}`));
    }
    return withInviteSummary(populated, shouldNotify);
  }

  const seriesId = new mongoose.Types.ObjectId();
  const start = new Date(base.startAt);
  const end = new Date(base.endAt);
  const created = [];

  for (let i = 0; i < count; i += 1) {
    const occurrence = new Meeting({
      ...base,
      seriesId,
      startAt: addInterval(start, frequency, i),
      endAt: addInterval(end, frequency, i),
    });
    await occurrence.save();
    created.push(occurrence);
  }

  const populated = await Meeting.findById(created[0]._id).populate(POPULATE);
  if (shouldNotify) {
    // One invitation for the series, not one per occurrence — the alternative is
    // 52 near-identical emails landing at once.
    notify
      .meetingScheduled(populated, { seriesCount: created.length })
      .catch((err) => logger.warn(`[meeting] series invitations failed for ${populated.reference}: ${err.message}`));
  }
  return withInviteSummary(populated, shouldNotify);
};

const buildFilter = ({ type, status, organiser, clientCompany, from, to, q, tag }) => {
  const filter = {};
  if (type && type !== 'all') filter.type = type;
  if (status && status !== 'all') filter.status = status;
  if (organiser) filter.organiser = organiser;
  if (clientCompany) filter['client.company'] = clientCompany;
  if (tag) filter.tags = tag;
  if (from || to) {
    filter.startAt = {};
    if (from) filter.startAt.$gte = new Date(from);
    if (to) filter.startAt.$lte = new Date(to);
  }
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { purpose: rx }, { 'client.name': rx }, { reference: rx }];
  }
  return filter;
};

const getAll = async ({ page = 1, limit = 25, sort = '-startAt', ...rest } = {}) => {
  const filter = buildFilter(rest);
  const skip = (Number(page) - 1) * Number(limit);
  const [meetings, total] = await Promise.all([
    Meeting.find(filter).populate(POPULATE).sort(sort).skip(skip).limit(Number(limit)),
    Meeting.countDocuments(filter),
  ]);
  return { meetings, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) };
};

/** Detail view: the meeting plus every task raised against it. */
const getById = async (id) => {
  const meeting = await Meeting.findById(id).populate(POPULATE);
  if (!meeting) return null;
  const tasks = await Task.find({ meeting: id })
    .populate({ path: 'assignee', select: 'fullName email' })
    .sort({ createdAt: -1 });
  return { meeting, tasks };
};

const update = async (id, data) => {
  const { notify: shouldNotify = true, ...payload } = data;
  // Keep the completion timestamp honest without making callers set it.
  if (payload.status === 'completed' && !payload.completedAt) payload.completedAt = new Date();
  if (payload.status && payload.status !== 'completed') payload.completedAt = null;

  // Read the old values first so we can describe what actually moved. Without
  // this the "updated" email says something changed but not what.
  const before = await Meeting.findById(id).select('startAt endAt location meetingLink format status durationMinutes');
  if (!before) return null;

  /**
   * Keep the derived duration in step when a meeting is rescheduled.
   *
   * The model computes this in a pre('save') hook, which findByIdAndUpdate does
   * NOT run — so moving a meeting used to leave the old duration behind, and the
   * invitation would say "(60 minutes)" about a slot that was now ninety.
   */
  if (payload.startAt || payload.endAt) {
    const start = new Date(payload.startAt ?? before.startAt);
    const end = new Date(payload.endAt ?? before.endAt);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      payload.durationMinutes = Math.max(0, Math.round((end - start) / 60000));
    }
  }

  const meeting = await Meeting.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).populate(POPULATE);
  if (!meeting || !shouldNotify) return meeting;

  if (payload.status === 'cancelled' && before.status !== 'cancelled') {
    notify.meetingCancelled(meeting).catch((err) =>
      logger.warn(`[meeting] cancellation emails failed for ${meeting.reference}: ${err.message}`));
    return meeting;
  }

  const changes = [];
  if (payload.startAt && new Date(payload.startAt).getTime() !== before.startAt?.getTime()) {
    // Business timezone, not the server's — see utils/timezone.js.
    changes.push(`Moved to ${formatDateTime(meeting.startAt)}`);
  }
  if (payload.location !== undefined && payload.location !== before.location) {
    changes.push(`Location is now ${meeting.location || 'TBC'}`);
  }
  if (payload.meetingLink !== undefined && payload.meetingLink !== before.meetingLink) {
    changes.push(before.meetingLink
      ? 'The meeting link changed'
      : `Joining link: ${meeting.meetingLink}`);
  }
  if (payload.format && payload.format !== before.format) {
    changes.push(`Format is now ${meeting.format.replace('_', ' ')}`);
  }

  // Only the changes attendees need to act on are worth an email — editing the
  // agenda or ticking items off is not one of them.
  if (changes.length > 0) {
    notify.meetingUpdated(meeting, changes).catch((err) =>
      logger.warn(`[meeting] update emails failed for ${meeting.reference}: ${err.message}`));
  }

  return meeting;
};

/**
 * Close out a session: minutes, outcome, decisions and who actually attended.
 * Separate from update() because this is a distinct action in the UI and it is
 * the moment attendance stops being a guess.
 */
const complete = async (
  id,
  { minutes, outcome, decisions, attendance, sendMinutes = false, markCompleted = true },
  actor,
) => {
  const meeting = await Meeting.findById(id);
  if (!meeting) return null;
  const who = actorFields(actor);

  if (minutes !== undefined) meeting.minutes = minutes;
  if (outcome !== undefined) meeting.outcome = outcome;

  if (Array.isArray(decisions)) {
    decisions
      .filter((d) => d && (typeof d === 'string' ? d.trim() : d.text))
      .forEach((d) => {
        meeting.decisions.push({
          text: typeof d === 'string' ? d : d.text,
          decidedBy: who.id,
          decidedByName: who.name,
        });
      });
  }

  // attendance: { [attendeeId]: boolean }
  if (attendance && typeof attendance === 'object') {
    meeting.attendees.forEach((a) => {
      if (Object.prototype.hasOwnProperty.call(attendance, String(a._id))) {
        a.attended = Boolean(attendance[String(a._id)]);
      }
    });
  }

  // Recording a decision or saving attendance mid-meeting must NOT close it out,
  // so status only moves when the caller actually meant to end the session.
  if (markCompleted) {
    meeting.status = 'completed';
    meeting.completedAt = new Date();
  }
  await meeting.save();

  const populated = await Meeting.findById(id).populate(POPULATE);

  // Circulating minutes is a deliberate act, so it is opt-in: saving attendance
  // or adding a decision should not blast the room with a half-written record.
  if (sendMinutes) {
    Task.find({ meeting: id })
      .select('title assigneeName dueAt')
      .then((actionItems) => notify.meetingMinutes(populated, actionItems))
      .catch((err) => logger.warn(`[meeting] minutes emails failed for ${populated.reference}: ${err.message}`));
  }

  return populated;
};

/** `scope: 'series'` removes every remaining occurrence, not just this one. */
const remove = async (id, scope = 'one') => {
  const meeting = await Meeting.findById(id);
  if (!meeting) return null;
  if (scope === 'series' && meeting.seriesId) {
    await Meeting.updateMany(
      { seriesId: meeting.seriesId, startAt: { $gte: meeting.startAt } },
      { deletedAt: new Date() }
    );
    return meeting;
  }
  return Meeting.softDeleteById(id);
};

/**
 * Calendar feed for a date range. Returns a flat, render-ready event list —
 * meetings, plus (optionally) task due dates so deadlines and sessions appear
 * on the same grid instead of in two places nobody cross-checks.
 */
const calendar = async ({ from, to, type, organiser, includeTasks = 'true' }) => {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : addInterval(start, 'monthly', 1);

  const meetingFilter = { startAt: { $gte: start, $lte: end } };
  if (type && type !== 'all') meetingFilter.type = type;
  if (organiser) meetingFilter.organiser = organiser;

  const meetings = await Meeting.find(meetingFilter)
    .populate([
      { path: 'organiser', select: 'fullName' },
      { path: 'client.company', select: 'name' },
    ])
    .sort({ startAt: 1 });

  const events = meetings.map((m) => ({
    kind: 'meeting',
    id: String(m._id),
    reference: m.reference,
    title: m.title,
    type: m.type,
    status: m.status,
    startAt: m.startAt,
    endAt: m.endAt,
    allDay: m.allDay,
    format: m.format,
    location: m.location,
    meetingLink: m.meetingLink,
    organiserName: m.organiser?.fullName ?? m.organiserName ?? null,
    clientName: m.client?.company?.name ?? m.client?.name ?? null,
    attendeeCount: m.attendees?.length ?? 0,
    colour: m.colour ?? null,
  }));

  if (String(includeTasks) !== 'false') {
    const tasks = await Task.find({
      dueAt: { $gte: start, $lte: end },
      status: { $nin: ['closed', 'wont_fix'] },
    })
      .populate({ path: 'assignee', select: 'fullName' })
      .sort({ dueAt: 1 });

    tasks.forEach((i) => {
      events.push({
        kind: 'task',
        id: String(i._id),
        reference: i.reference,
        title: i.title,
        type: i.type,
        status: i.status,
        priority: i.priority,
        startAt: i.dueAt,
        endAt: i.dueAt,
        allDay: true,
        assigneeName: i.assignee?.fullName ?? i.assigneeName ?? null,
      });
    });
  }

  events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  return { from: start, to: end, events, total: events.length };
};

/** Header KPIs for the meetings page. */
const summary = async () => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const in7 = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  const last30 = new Date(startOfToday.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [today, upcoming7, completed30, cancelled30, byType, needsMinutes] = await Promise.all([
    Meeting.countDocuments({ startAt: { $gte: startOfToday, $lt: endOfToday }, status: { $ne: 'cancelled' } }),
    Meeting.countDocuments({ startAt: { $gte: now, $lte: in7 }, status: 'scheduled' }),
    Meeting.countDocuments({ startAt: { $gte: last30 }, status: 'completed' }),
    Meeting.countDocuments({ startAt: { $gte: last30 }, status: 'cancelled' }),
    Meeting.aggregate([
      { $match: { deletedAt: null, startAt: { $gte: last30 } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    // Past sessions still marked scheduled — the "write your minutes" nudge.
    Meeting.countDocuments({ startAt: { $lt: now }, status: 'scheduled' }),
  ]);

  return {
    today,
    upcoming7,
    completed30,
    cancelled30,
    needsMinutes,
    byType: byType.map((t) => ({ type: t._id, count: t.count })),
  };
};

module.exports = { create, getAll, getById, update, complete, remove, calendar, summary };
