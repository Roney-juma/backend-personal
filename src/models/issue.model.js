const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

/**
 * Issue — anything the platform team is tracking internally: a bug, a client
 * remark from a demo, a blocker, a risk, an action item out of a meeting.
 *
 * One tracker rather than several. An action item raised in a meeting is an
 * Issue with `meeting` set and `source: 'meeting'`; a remark a prospect made
 * during a demo is an Issue with `source: 'client_demo'` and the same meeting
 * link. That way nothing lives only inside a minutes document, and the meeting
 * detail page can simply list the issues pointing at it.
 */

const ISSUE_TYPES = [
  'bug',
  'feature_request',
  'client_feedback',
  'task',
  'blocker',
  'risk',
  'decision',
  'improvement',
  'question',
  'other',
];

const ISSUE_STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'resolved', 'closed', 'wont_fix'];

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

// Product areas, so reporting can answer "where is the pain concentrated".
const AREAS = [
  'claims',
  'ai_fraud',
  'legal',
  'partners',
  'billing',
  'provider_portal',
  'company_portal',
  'mobile_app',
  'api',
  'infrastructure',
  'security',
  'sales',
  'process',
  'other',
];

const SOURCES = [
  'internal',
  'meeting',
  'client_demo',
  'client_feedback',
  'support_ticket',
  'monitoring',
  'testing',
  'other',
];

const commentSchema = new mongoose.Schema(
  {
    body: { type: String, required: true, trim: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'providerUser' },
    authorName: { type: String, trim: true },
  },
  { _id: true, timestamps: true }
);

/**
 * Append-only status trail. Cheap to write and it answers the question every
 * status report asks: how long did this actually sit in each state.
 */
const historySchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: { type: String },
    to: { type: String },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'providerUser' },
    changedByName: { type: String, trim: true },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const issueSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    type: { type: String, enum: ISSUE_TYPES, default: 'task', index: true },
    priority: { type: String, enum: PRIORITIES, default: 'medium', index: true },
    status: { type: String, enum: ISSUE_STATUSES, default: 'open', index: true },
    area: { type: String, enum: AREAS, default: 'other' },

    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'providerUser', index: true },
    assigneeName: { type: String, trim: true },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'providerUser' },
    reporterName: { type: String, trim: true },
    watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'providerUser' }],

    // Where it came from. `meeting` is set for anything raised in a session —
    // the meeting detail page lists its issues by querying this field.
    source: { type: String, enum: SOURCES, default: 'internal' },
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', index: true },
    // Optional client context: a live tenant, or a prospect by name.
    relatedCompany: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany' },
    clientName: { type: String, trim: true },

    dueAt: { type: Date, index: true },
    startedAt: { type: Date },
    resolvedAt: { type: Date },
    closedAt: { type: Date },

    effort: { type: String, enum: ['xs', 's', 'm', 'l', 'xl'] },
    resolution: { type: String, trim: true },
    blockedReason: { type: String, trim: true },

    labels: [{ type: String, trim: true }],
    comments: [commentSchema],
    history: [historySchema],

    // Free-form links to other issues (duplicates, blockers, follow-ups).
    relatedIssues: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Issue' }],
  },
  { timestamps: true }
);

issueSchema.plugin(softDelete);

// Board columns, "my issues", and the overdue query respectively.
issueSchema.index({ status: 1, priority: -1, updatedAt: -1 });
issueSchema.index({ assignee: 1, status: 1 });
issueSchema.index({ dueAt: 1, status: 1 });
issueSchema.index({ title: 'text', description: 'text' });

issueSchema.pre('save', async function assignReference(next) {
  if (this.reference) return next();
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const count = await mongoose.model('Issue').countDocuments({}).setOptions({ withDeleted: true });
  this.reference = `ISS-${yyyymm}-${String(count + 1).padStart(4, '0')}`;
  next();
});

const Issue = mongoose.model('Issue', issueSchema);

Issue.ISSUE_TYPES = ISSUE_TYPES;
Issue.ISSUE_STATUSES = ISSUE_STATUSES;
Issue.PRIORITIES = PRIORITIES;
Issue.AREAS = AREAS;
Issue.SOURCES = SOURCES;

module.exports = Issue;
