const Prospect = require('../models/prospect.model');
const Meeting = require('../models/meeting.model');
const Task = require('../models/task.model');
const ApiError = require('../utils/ApiError');

// Populate targets must be registered before the first populate() — see the
// same note in meeting.service.js.
require('../models/providerUser.model');
require('../models/insuranceCompany.model');

const POPULATE = [
  { path: 'owner', select: 'fullName email' },
  { path: 'company', select: 'companyName name email' },
];

/**
 * How long a prospect can go unheard-from before the list says so.
 *
 * A threshold, not a rule — some sales cycles are slow and that is fine. The
 * point is that nobody has to remember which name they last saw a month ago.
 */
const COLD_AFTER_DAYS = Number(process.env.PROSPECT_COLD_AFTER_DAYS || 21);

const actorFields = (actor) => ({
  id: actor?.id ?? actor?._id ?? null,
  name: actor?.fullName ?? actor?.username ?? actor?.email ?? 'Unknown',
});

/**
 * Every meeting belonging to a prospect.
 *
 * Matched three ways, in order of confidence: an explicit `prospect` link on the
 * meeting, the same InsuranceCompany, or the client name typed on the meeting.
 * The name fallback exists because meetings were being recorded before prospects
 * existed, and re-keying that history would defeat the point of deriving it.
 */
const meetingFilterFor = (prospect) => {
  const or = [{ prospect: prospect._id }];
  if (prospect.company) or.push({ 'client.company': prospect.company._id ?? prospect.company });
  if (prospect.name) {
    // Anchored and escaped: a prospect called "AIG" must not match "AIG Kenya
    // Holdings" by accident, but case and stray spacing should not matter.
    const escaped = String(prospect.name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    or.push({ 'client.name': new RegExp(`^\\s*${escaped}\\s*$`, 'i') });
  }
  return { $or: or };
};

const days = (from) => (from ? Math.floor((Date.now() - new Date(from)) / 86400000) : null);

/**
 * Attach the observed activity: demos held, when we last spoke, what is next.
 *
 * Done as one query per collection across the whole page rather than per row —
 * a pipeline of forty prospects should not be forty round trips.
 */
async function withActivity(prospects) {
  if (prospects.length === 0) return [];
  const now = new Date();

  const filters = prospects.map((p) => meetingFilterFor(p));
  const meetings = await Meeting.find({ $or: filters })
    .select('prospect client type status startAt title')
    .lean();

  const companyIds = prospects.map((p) => p.company?._id ?? p.company).filter(Boolean);
  const names = prospects.map((p) => p.name).filter(Boolean);
  const tasks = await Task.find({
    status: { $nin: ['resolved', 'closed', 'wont_fix'] },
    $or: [
      ...(companyIds.length ? [{ relatedCompany: { $in: companyIds } }] : []),
      ...(names.length ? [{ clientName: { $in: names } }] : []),
    ],
  })
    .select('relatedCompany clientName')
    .lean();

  const belongs = (meeting, prospect) => {
    if (meeting.prospect && String(meeting.prospect) === String(prospect._id)) return true;
    const pCompany = prospect.company?._id ?? prospect.company;
    if (pCompany && meeting.client?.company && String(meeting.client.company) === String(pCompany)) return true;
    const mName = meeting.client?.name?.trim().toLowerCase();
    return Boolean(mName && mName === String(prospect.name).trim().toLowerCase());
  };

  return prospects.map((p) => {
    const mine = meetings.filter((m) => belongs(m, p));
    const held = mine.filter((m) => m.status === 'completed');
    const demosHeld = held.filter((m) => m.type === 'client_demo').length;

    const lastContactAt = held
      .map((m) => m.startAt)
      .sort((a, b) => new Date(b) - new Date(a))[0] ?? null;

    const next = mine
      .filter((m) => m.status === 'scheduled' && new Date(m.startAt) >= now)
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0] ?? null;

    const openTasks = tasks.filter((t) => {
      const pCompany = p.company?._id ?? p.company;
      if (pCompany && t.relatedCompany && String(t.relatedCompany) === String(pCompany)) return true;
      return Boolean(t.clientName && t.clientName.trim().toLowerCase() === String(p.name).trim().toLowerCase());
    }).length;

    const daysSinceContact = days(lastContactAt);
    const open = Prospect.OPEN_STAGES.includes(p.stage);

    return {
      ...p,
      activity: {
        meetingsHeld: held.length,
        demosHeld,
        lastContactAt,
        daysSinceContact,
        nextMeetingAt: next?.startAt ?? null,
        nextMeetingTitle: next?.title ?? null,
        openTasks,
        /**
         * Cold means: still being worked, nothing in the diary, and either
         * nothing heard for a while or never contacted at all. A prospect with
         * a meeting booked is never cold, however long the gap has been.
         */
        cold:
          open &&
          !next &&
          (daysSinceContact === null ? days(p.createdAt) >= COLD_AFTER_DAYS : daysSinceContact >= COLD_AFTER_DAYS),
      },
    };
  });
}

const create = async (data, actor) => {
  const who = actorFields(actor);
  if (!String(data.name || '').trim()) throw new ApiError(400, 'A prospect needs the insurer\'s name');

  const prospect = new Prospect({
    ...data,
    owner: data.owner ?? who.id,
    ownerName: data.ownerName ?? who.name,
  });
  await prospect.save();
  return Prospect.findById(prospect._id).populate(POPULATE);
};

const getAll = async ({ stage, owner, q, cold, page = 1, limit = 100, sort = '-updatedAt' } = {}) => {
  const filter = {};
  if (stage && stage !== 'all') {
    filter.stage = stage === 'open' ? { $in: Prospect.OPEN_STAGES } : stage;
  }
  if (owner) filter.owner = owner;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { reference: rx }, { 'contact.name': rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    Prospect.find(filter).populate(POPULATE).sort(sort).skip(skip).limit(Number(limit)).lean(),
    Prospect.countDocuments(filter),
  ]);

  let prospects = await withActivity(rows);
  // Filtered after enrichment because "cold" is derived, not stored.
  if (String(cold) === 'true') prospects = prospects.filter((p) => p.activity.cold);

  return { prospects, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) };
};

/** One prospect, with its meetings and open tasks in full. */
const getById = async (id) => {
  const prospect = await Prospect.findById(id).populate(POPULATE).lean();
  if (!prospect) return null;

  const [enriched] = await withActivity([prospect]);
  const meetings = await Meeting.find(meetingFilterFor(prospect))
    .select('reference title type status startAt client outcome')
    .sort({ startAt: -1 })
    .limit(50)
    .lean();

  return { prospect: enriched, meetings };
};

const update = async (id, data) => {
  const prospect = await Prospect.findById(id);
  if (!prospect) return null;
  Object.entries(data).forEach(([k, v]) => {
    if (['_id', 'reference', 'createdAt', 'updatedAt'].includes(k)) return;
    prospect[k] = v;
  });
  await prospect.save();
  return Prospect.findById(id).populate(POPULATE);
};

const remove = async (id) => Prospect.softDeleteById(id);

/** Header numbers for the pipeline. */
const summary = async () => {
  const byStage = await Prospect.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: '$stage', count: { $sum: 1 } } },
  ]);

  const openRows = await Prospect.find({ stage: { $in: Prospect.OPEN_STAGES } }).lean();
  const enriched = await withActivity(openRows);

  const now = new Date();
  return {
    byStage: byStage.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {}),
    open: openRows.length,
    cold: enriched.filter((p) => p.activity.cold).length,
    // A next step whose date has passed is the pipeline's overdue list.
    overdueNextStep: openRows.filter((p) => p.nextStepAt && new Date(p.nextStepAt) < now).length,
    demosHeld: enriched.reduce((acc, p) => acc + p.activity.demosHeld, 0),
    coldAfterDays: COLD_AFTER_DAYS,
  };
};

/**
 * Turn an inbound demo request into a prospect.
 *
 * The request stays the audit trail of how they reached us; the prospect is what
 * gets worked from here.
 */
const fromDemoRequest = async (demoRequest, actor) => {
  const existing = await Prospect.findOne({ demoRequest: demoRequest._id });
  if (existing) return Prospect.findById(existing._id).populate(POPULATE);

  return create(
    {
      name: demoRequest.company || demoRequest.fullName,
      contact: {
        name: demoRequest.fullName,
        email: demoRequest.email,
        phone: demoRequest.phoneNumber,
      },
      source: 'inbound_request',
      demoRequest: demoRequest._id,
      stage: 'new',
      notes: demoRequest.message,
    },
    actor
  );
};

module.exports = { create, getAll, getById, update, remove, summary, fromDemoRequest, withActivity };
