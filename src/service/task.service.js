const Task = require('../models/task.model');
const notify = require('./workspaceNotify.service');
const logger = require('../middlewheres/logger');
const { formatShortDate } = require('../utils/timezone');

// Populate targets must be registered before the first populate() call — see the
// same note in meeting.service.js. 'ProviderUser' is case-sensitive.
require('../models/providerUser.model');
require('../models/insuranceCompany.model');
require('../models/meeting.model');

const POPULATE = [
  { path: 'assignee', select: 'fullName email profilePictureUrl' },
  { path: 'reporter', select: 'fullName email' },
  { path: 'meeting', select: 'reference title startAt type' },
  { path: 'relatedCompany', select: 'name' },
];

// Statuses that mean "no longer being worked on" — used by the overdue and
// open-count queries so closed work never shows up as outstanding.
const TERMINAL = ['resolved', 'closed', 'wont_fix'];

/** Field names as a person would say them, for the change list in update mail. */
const FIELD_LABELS = {
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  area: 'Area',
};

const actorFields = (actor) => ({
  id: actor?.id ?? actor?._id ?? null,
  name: actor?.fullName ?? actor?.username ?? actor?.email ?? 'Unknown',
});

/** Address of a populated ref, or null when it was never populated/set. */
const emailOf = (ref) => (ref && typeof ref === 'object' ? ref.email ?? null : null);

/** Everyone who should hear about a task, minus whoever caused the event. */
const followersOf = (task, excludeId) => {
  const out = [];
  const seen = new Set();
  [task.assignee, task.reporter].forEach((ref) => {
    const email = emailOf(ref);
    if (!email) return;
    if (excludeId && String(ref._id) === String(excludeId)) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email, name: ref.fullName });
  });
  return out;
};

const create = async (data, actor) => {
  const who = actorFields(actor);
  const { notify: shouldNotify = true, ...rest } = data;
  const task = new Task({
    ...rest,
    reporter: rest.reporter ?? who.id,
    reporterName: rest.reporterName ?? who.name,
  });
  await task.save();
  const populated = await Task.findById(task._id).populate(POPULATE);

  // Assigning to yourself needs no email — you already know.
  const assigneeId = populated.assignee?._id;
  if (shouldNotify && assigneeId && String(assigneeId) !== String(who.id)) {
    notify
      .taskAssigned(populated, emailOf(populated.assignee), populated.assignee.fullName)
      .catch((err) => logger.warn(`[task] assignment email failed for ${populated.reference}: ${err.message}`));
  }

  return populated;
};

const buildFilter = ({ status, priority, type, area, assignee, reporter, source, meeting, relatedCompany, label, overdue, q, from, to }) => {
  const filter = {};
  if (status && status !== 'all') {
    // 'open' as a filter means "still live", not literally status === 'open'.
    filter.status = status === 'active' ? { $nin: TERMINAL } : status;
  }
  if (priority && priority !== 'all') filter.priority = priority;
  if (type && type !== 'all') filter.type = type;
  if (area && area !== 'all') filter.area = area;
  if (assignee) filter.assignee = assignee === 'unassigned' ? null : assignee;
  if (reporter) filter.reporter = reporter;
  if (source && source !== 'all') filter.source = source;
  if (meeting) filter.meeting = meeting;
  if (relatedCompany) filter.relatedCompany = relatedCompany;
  if (label) filter.labels = label;
  if (String(overdue) === 'true') {
    filter.dueAt = { $lt: new Date() };
    filter.status = { $nin: TERMINAL };
  }
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { description: rx }, { reference: rx }];
  }
  return filter;
};

const getAll = async ({ page = 1, limit = 50, sort = '-updatedAt', ...rest } = {}) => {
  const filter = buildFilter(rest);
  const skip = (Number(page) - 1) * Number(limit);
  const [tasks, total] = await Promise.all([
    Task.find(filter).populate(POPULATE).sort(sort).skip(skip).limit(Number(limit)),
    Task.countDocuments(filter),
  ]);
  return { tasks, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) };
};

const getById = async (id) => Task.findById(id).populate(POPULATE);

/**
 * Update with an automatic audit trail. Only the fields that actually changed
 * are appended to `history`, and the lifecycle timestamps are derived from the
 * status transition rather than trusted from the client.
 */
const update = async (id, rawData, actor) => {
  const { notify: shouldNotify = true, ...data } = rawData;
  const task = await Task.findById(id);
  if (!task) return null;
  const who = actorFields(actor);

  const previousAssignee = task.assignee ? String(task.assignee) : null;
  const previousStatus = task.status;

  const TRACKED = ['status', 'priority', 'assignee', 'type', 'area', 'dueAt'];
  // The same pass that writes history also builds the sentence people read in
  // the notification — one source of truth for "what actually changed", so the
  // audit trail and the email can never disagree.
  const changes = [];
  TRACKED.forEach((field) => {
    if (!(field in data)) return;
    const before = task[field] == null ? '' : String(task[field]);
    const after = data[field] == null ? '' : String(data[field]);
    if (before !== after) {
      task.history.push({
        field,
        from: before || null,
        to: after || null,
        changedBy: who.id,
        changedByName: who.name,
      });
      // Assignee is an id — the reassignment mail names the new owner properly,
      // so there is nothing useful to say here.
      if (field === 'assignee') {
        changes.push('Reassigned');
      } else if (field === 'dueAt') {
        changes.push(`Due date is now ${data.dueAt ? formatShortDate(data.dueAt) : 'unset'}`);
      } else {
        changes.push(`${FIELD_LABELS[field] ?? field} is now ${String(after || 'unset').replace(/_/g, ' ')}`);
      }
    }
  });

  Object.entries(data).forEach(([key, value]) => {
    if (['_id', 'reference', 'history', 'comments', 'createdAt', 'updatedAt'].includes(key)) return;
    task[key] = value;
  });

  if (data.status) {
    if (data.status === 'in_progress' && !task.startedAt) task.startedAt = new Date();
    if (data.status === 'resolved') task.resolvedAt = task.resolvedAt ?? new Date();
    if (data.status === 'closed' || data.status === 'wont_fix') task.closedAt = task.closedAt ?? new Date();
    if (!TERMINAL.includes(data.status)) {
      task.resolvedAt = null;
      task.closedAt = null;
    }
  }

  await task.save();
  const populated = await Task.findById(id).populate(POPULATE);
  if (!shouldNotify) return populated;

  // Reassignment: tell the new owner (unless they did it themselves).
  const nowAssignee = populated.assignee?._id ? String(populated.assignee._id) : null;
  if (nowAssignee && nowAssignee !== previousAssignee && nowAssignee !== String(who.id)) {
    notify
      .taskAssigned(populated, emailOf(populated.assignee), populated.assignee.fullName)
      .catch((err) => logger.warn(`[task] assignment email failed for ${populated.reference}: ${err.message}`));
  }

  // Closing out: tell the people following it, not the person who closed it.
  const closedOut = Boolean(data.status && data.status !== previousStatus && TERMINAL.includes(data.status));
  if (closedOut) {
    const recipients = followersOf(populated, who.id);
    if (recipients.length > 0) {
      notify.taskResolved(populated, recipients).catch((err) =>
        logger.warn(`[task] resolution emails failed for ${populated.reference}: ${err.message}`));
    }
  } else if (changes.length > 0) {
    /**
     * Any other material edit — a status move, a priority bump, a new due date.
     * Previously these were silent: a task could be reprioritised and pulled
     * forward two weeks and the only person who knew was whoever typed it.
     *
     * The new owner is excluded because the reassignment mail above already
     * tells them everything, and the actor because they just did this.
     */
    const nowAssigneeEmail = nowAssignee !== previousAssignee ? emailOf(populated.assignee) : null;
    const recipients = followersOf(populated, who.id).filter(
      (r) => !nowAssigneeEmail || r.email.toLowerCase() !== nowAssigneeEmail.toLowerCase(),
    );
    if (recipients.length > 0) {
      notify.taskUpdated(populated, changes, recipients).catch((err) =>
        logger.warn(`[task] update emails failed for ${populated.reference}: ${err.message}`));
    }
  }

  return populated;
};

const addComment = async (id, body, actor) => {
  const who = actorFields(actor);
  const task = await Task.findByIdAndUpdate(
    id,
    { $push: { comments: { body, author: who.id, authorName: who.name } } },
    { new: true }
  ).populate(POPULATE);
  if (!task) return null;

  const recipients = followersOf(task, who.id);
  if (recipients.length > 0) {
    notify
      .taskCommented(task, { body, authorName: who.name }, recipients)
      .catch((err) => logger.warn(`[task] comment emails failed for ${task.reference}: ${err.message}`));
  }

  return task;
};

const remove = async (id) => Task.softDeleteById(id);

/**
 * Board/report numbers. Everything here is computed server-side so the page
 * does not have to pull every task just to count them.
 */
const summary = async () => {
  const now = new Date();
  const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [byStatus, byPriority, byType, byArea, overdue, unassigned, dueSoon, resolved30, topAssignees, resolutionTimes] =
    await Promise.all([
      Task.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Task.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL } } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Task.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Task.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL } } },
        { $group: { _id: '$area', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Task.countDocuments({ dueAt: { $lt: now }, status: { $nin: TERMINAL } }),
      Task.countDocuments({ assignee: null, status: { $nin: TERMINAL } }),
      Task.countDocuments({ dueAt: { $gte: now, $lte: in7 }, status: { $nin: TERMINAL } }),
      Task.countDocuments({ resolvedAt: { $gte: last30 } }),
      Task.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL }, assignee: { $ne: null } } },
        { $group: { _id: '$assignee', name: { $first: '$assigneeName' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      // Mean days from creation to resolution over the last 30 days.
      Task.aggregate([
        { $match: { deletedAt: null, resolvedAt: { $gte: last30 } } },
        { $project: { days: { $divide: [{ $subtract: ['$resolvedAt', '$createdAt'] }, 1000 * 60 * 60 * 24] } } },
        { $group: { _id: null, avgDays: { $avg: '$days' }, count: { $sum: 1 } } },
      ]),
    ]);

  const asMap = (rows) => rows.reduce((acc, r) => ({ ...acc, [r._id ?? 'unknown']: r.count }), {});
  const openTotal = byStatus
    .filter((s) => !TERMINAL.includes(s._id))
    .reduce((sum, s) => sum + s.count, 0);

  return {
    openTotal,
    overdue,
    unassigned,
    dueSoon,
    resolved30,
    avgResolutionDays: resolutionTimes[0]?.avgDays ? Number(resolutionTimes[0].avgDays.toFixed(1)) : null,
    byStatus: asMap(byStatus),
    byPriority: asMap(byPriority),
    byType: byType.map((t) => ({ type: t._id, count: t.count })),
    byArea: byArea.map((a) => ({ area: a._id, count: a.count })),
    topAssignees: topAssignees.map((a) => ({ id: String(a._id), name: a.name ?? 'Unknown', count: a.count })),
  };
};

module.exports = { create, getAll, getById, update, addComment, remove, summary };
