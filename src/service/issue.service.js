const Issue = require('../models/issue.model');
const notify = require('./workspaceNotify.service');
const logger = require('../middlewheres/logger');

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

const actorFields = (actor) => ({
  id: actor?.id ?? actor?._id ?? null,
  name: actor?.fullName ?? actor?.username ?? actor?.email ?? 'Unknown',
});

/** Address of a populated ref, or null when it was never populated/set. */
const emailOf = (ref) => (ref && typeof ref === 'object' ? ref.email ?? null : null);

/** Everyone who should hear about an issue, minus whoever caused the event. */
const followersOf = (issue, excludeId) => {
  const out = [];
  const seen = new Set();
  [issue.assignee, issue.reporter].forEach((ref) => {
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
  const issue = new Issue({
    ...rest,
    reporter: rest.reporter ?? who.id,
    reporterName: rest.reporterName ?? who.name,
  });
  await issue.save();
  const populated = await Issue.findById(issue._id).populate(POPULATE);

  // Assigning to yourself needs no email — you already know.
  const assigneeId = populated.assignee?._id;
  if (shouldNotify && assigneeId && String(assigneeId) !== String(who.id)) {
    notify
      .issueAssigned(populated, emailOf(populated.assignee), populated.assignee.fullName)
      .catch((err) => logger.warn(`[issue] assignment email failed for ${populated.reference}: ${err.message}`));
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
  const [issues, total] = await Promise.all([
    Issue.find(filter).populate(POPULATE).sort(sort).skip(skip).limit(Number(limit)),
    Issue.countDocuments(filter),
  ]);
  return { issues, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) };
};

const getById = async (id) => Issue.findById(id).populate(POPULATE);

/**
 * Update with an automatic audit trail. Only the fields that actually changed
 * are appended to `history`, and the lifecycle timestamps are derived from the
 * status transition rather than trusted from the client.
 */
const update = async (id, rawData, actor) => {
  const { notify: shouldNotify = true, ...data } = rawData;
  const issue = await Issue.findById(id);
  if (!issue) return null;
  const who = actorFields(actor);

  const previousAssignee = issue.assignee ? String(issue.assignee) : null;
  const previousStatus = issue.status;

  const TRACKED = ['status', 'priority', 'assignee', 'type', 'area', 'dueAt'];
  TRACKED.forEach((field) => {
    if (!(field in data)) return;
    const before = issue[field] == null ? '' : String(issue[field]);
    const after = data[field] == null ? '' : String(data[field]);
    if (before !== after) {
      issue.history.push({
        field,
        from: before || null,
        to: after || null,
        changedBy: who.id,
        changedByName: who.name,
      });
    }
  });

  Object.entries(data).forEach(([key, value]) => {
    if (['_id', 'reference', 'history', 'comments', 'createdAt', 'updatedAt'].includes(key)) return;
    issue[key] = value;
  });

  if (data.status) {
    if (data.status === 'in_progress' && !issue.startedAt) issue.startedAt = new Date();
    if (data.status === 'resolved') issue.resolvedAt = issue.resolvedAt ?? new Date();
    if (data.status === 'closed' || data.status === 'wont_fix') issue.closedAt = issue.closedAt ?? new Date();
    if (!TERMINAL.includes(data.status)) {
      issue.resolvedAt = null;
      issue.closedAt = null;
    }
  }

  await issue.save();
  const populated = await Issue.findById(id).populate(POPULATE);
  if (!shouldNotify) return populated;

  // Reassignment: tell the new owner (unless they did it themselves).
  const nowAssignee = populated.assignee?._id ? String(populated.assignee._id) : null;
  if (nowAssignee && nowAssignee !== previousAssignee && nowAssignee !== String(who.id)) {
    notify
      .issueAssigned(populated, emailOf(populated.assignee), populated.assignee.fullName)
      .catch((err) => logger.warn(`[issue] assignment email failed for ${populated.reference}: ${err.message}`));
  }

  // Closing out: tell the people following it, not the person who closed it.
  if (data.status && data.status !== previousStatus && TERMINAL.includes(data.status)) {
    const recipients = followersOf(populated, who.id);
    if (recipients.length > 0) {
      notify.issueResolved(populated, recipients).catch((err) =>
        logger.warn(`[issue] resolution emails failed for ${populated.reference}: ${err.message}`));
    }
  }

  return populated;
};

const addComment = async (id, body, actor) => {
  const who = actorFields(actor);
  const issue = await Issue.findByIdAndUpdate(
    id,
    { $push: { comments: { body, author: who.id, authorName: who.name } } },
    { new: true }
  ).populate(POPULATE);
  if (!issue) return null;

  const recipients = followersOf(issue, who.id);
  if (recipients.length > 0) {
    notify
      .issueCommented(issue, { body, authorName: who.name }, recipients)
      .catch((err) => logger.warn(`[issue] comment emails failed for ${issue.reference}: ${err.message}`));
  }

  return issue;
};

const remove = async (id) => Issue.softDeleteById(id);

/**
 * Board/report numbers. Everything here is computed server-side so the page
 * does not have to pull every issue just to count them.
 */
const summary = async () => {
  const now = new Date();
  const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [byStatus, byPriority, byType, byArea, overdue, unassigned, dueSoon, resolved30, topAssignees, resolutionTimes] =
    await Promise.all([
      Issue.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Issue.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL } } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Issue.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Issue.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL } } },
        { $group: { _id: '$area', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Issue.countDocuments({ dueAt: { $lt: now }, status: { $nin: TERMINAL } }),
      Issue.countDocuments({ assignee: null, status: { $nin: TERMINAL } }),
      Issue.countDocuments({ dueAt: { $gte: now, $lte: in7 }, status: { $nin: TERMINAL } }),
      Issue.countDocuments({ resolvedAt: { $gte: last30 } }),
      Issue.aggregate([
        { $match: { deletedAt: null, status: { $nin: TERMINAL }, assignee: { $ne: null } } },
        { $group: { _id: '$assignee', name: { $first: '$assigneeName' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      // Mean days from creation to resolution over the last 30 days.
      Issue.aggregate([
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
