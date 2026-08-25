const mongoose = require('mongoose');
const Meeting = require('../models/meeting.model');
const Issue = require('../models/issue.model');

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
 * Create a meeting, expanding a recurrence rule into real occurrences.
 * Occurrences are saved one at a time (not insertMany) because the reference
 * counter lives in a pre-save hook, which insertMany bypasses.
 */
const create = async (data, actor) => {
  const who = actorFields(actor);
  const base = {
    ...data,
    organiser: data.organiser ?? who.id,
    organiserName: data.organiserName ?? who.name,
  };

  const frequency = base.recurrence?.frequency ?? 'none';
  const count = Math.min(Number(base.recurrence?.count ?? 1) || 1, 52);

  if (frequency === 'none' || count <= 1) {
    const meeting = new Meeting(base);
    await meeting.save();
    return Meeting.findById(meeting._id).populate(POPULATE);
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

  return Meeting.findById(created[0]._id).populate(POPULATE);
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

/** Detail view: the meeting plus every issue raised against it. */
const getById = async (id) => {
  const meeting = await Meeting.findById(id).populate(POPULATE);
  if (!meeting) return null;
  const issues = await Issue.find({ meeting: id })
    .populate({ path: 'assignee', select: 'fullName email' })
    .sort({ createdAt: -1 });
  return { meeting, issues };
};

const update = async (id, data) => {
  const payload = { ...data };
  // Keep the completion timestamp honest without making callers set it.
  if (payload.status === 'completed' && !payload.completedAt) payload.completedAt = new Date();
  if (payload.status && payload.status !== 'completed') payload.completedAt = null;
  return Meeting.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).populate(POPULATE);
};

/**
 * Close out a session: minutes, outcome, decisions and who actually attended.
 * Separate from update() because this is a distinct action in the UI and it is
 * the moment attendance stops being a guess.
 */
const complete = async (id, { minutes, outcome, decisions, attendance }, actor) => {
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

  meeting.status = 'completed';
  meeting.completedAt = new Date();
  await meeting.save();
  return Meeting.findById(id).populate(POPULATE);
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
 * meetings, plus (optionally) issue due dates so deadlines and sessions appear
 * on the same grid instead of in two places nobody cross-checks.
 */
const calendar = async ({ from, to, type, organiser, includeIssues = 'true' }) => {
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

  if (String(includeIssues) !== 'false') {
    const issues = await Issue.find({
      dueAt: { $gte: start, $lte: end },
      status: { $nin: ['closed', 'wont_fix'] },
    })
      .populate({ path: 'assignee', select: 'fullName' })
      .sort({ dueAt: 1 });

    issues.forEach((i) => {
      events.push({
        kind: 'issue',
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
