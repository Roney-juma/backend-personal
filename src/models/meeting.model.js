const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

/**
 * Meeting — an internal or client-facing session on the platform team's calendar.
 *
 * Deliberately standalone: a meeting knows nothing about the public "Request a
 * Demo" form. A client demo is just a meeting with `type: 'client_demo'` and an
 * optional `client` block, so prospects who never filled in a form are tracked
 * exactly like everyone else.
 *
 * Action items are NOT stored here. They are Issues carrying `meeting: <id>`,
 * so an item raised in a meeting lives in the same tracker as everything else
 * and does not go stale in a minutes document. See issue.model.js.
 */

const MEETING_TYPES = [
  'internal',
  'client_demo',
  'client_meeting',
  'standup',
  'planning',
  'review',
  'retrospective',
  'training',
  'one_on_one',
  'interview',
  'board',
  'other',
];

const MEETING_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled', 'postponed'];

/** One agenda line. `order` is explicit so items can be reordered in the UI. */
const agendaItemSchema = new mongoose.Schema(
  {
    order: { type: Number, default: 0 },
    item: { type: String, required: true, trim: true },
    presenter: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderUser' },
    presenterName: { type: String, trim: true },
    durationMinutes: { type: Number },
    notes: { type: String, trim: true },
    covered: { type: Boolean, default: false },
  },
  { _id: true }
);

/**
 * An attendee is either a staff member (`user` set) or an external guest
 * (`user` null, `organisation` set). `attended` is filled in after the fact —
 * the gap between invited and attended is what makes attendance reporting useful.
 */
const attendeeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderUser' },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    title: { type: String, trim: true },
    organisation: { type: String, trim: true },
    isExternal: { type: Boolean, default: false },
    response: { type: String, enum: ['pending', 'accepted', 'declined', 'tentative'], default: 'pending' },
    attended: { type: Boolean, default: null },
  },
  { _id: true }
);

/** A decision recorded in the meeting — the part of the minutes people re-read. */
const decisionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderUser' },
    decidedByName: { type: String, trim: true },
    decidedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const meetingSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true },

    title: { type: String, required: true, trim: true },
    type: { type: String, enum: MEETING_TYPES, default: 'internal', index: true },
    purpose: { type: String, trim: true },

    // Scheduling. startAt/endAt are the calendar's only source of truth —
    // durationMinutes is derived on save so the two can never disagree.
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true },
    durationMinutes: { type: Number },
    allDay: { type: Boolean, default: false },

    format: { type: String, enum: ['in_person', 'virtual', 'hybrid'], default: 'virtual' },
    location: { type: String, trim: true },
    meetingLink: { type: String, trim: true },

    organiser: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderUser', index: true },
    organiserName: { type: String, trim: true },
    attendees: [attendeeSchema],

    agenda: [agendaItemSchema],

    /**
     * Who this is with, when it is client-facing. `company` links to a live
     * tenant; `name` covers prospects who are not on the platform yet. Both are
     * optional — internal meetings leave the whole block empty.
     */
    /**
     * The prospect this session belongs to, when it is one. Optional: meetings
     * predate prospects, so the pipeline also matches on company and client
     * name — this link is simply the unambiguous version.
     */
    prospect: { type: mongoose.Schema.Types.ObjectId, ref: 'Prospect', index: true },

    client: {
      company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany' },
      name: { type: String, trim: true },
      contactName: { type: String, trim: true },
      contactEmail: { type: String, trim: true, lowercase: true },
      contactPhone: { type: String, trim: true },
    },

    status: { type: String, enum: MEETING_STATUSES, default: 'scheduled', index: true },

    // Post-meeting record
    minutes: { type: String, trim: true },
    decisions: [decisionSchema],
    outcome: { type: String, trim: true },
    completedAt: { type: Date },
    cancelledReason: { type: String, trim: true },

    /**
     * Recurring meetings are expanded into individual documents at creation
     * time and stitched together by `seriesId`. Storing real occurrences (rather
     * than a rule evaluated at read time) keeps the calendar query a plain range
     * scan and lets a single occurrence be moved or cancelled on its own.
     */
    seriesId: { type: mongoose.Schema.Types.ObjectId, index: true },
    recurrence: {
      frequency: { type: String, enum: ['none', 'daily', 'weekly', 'biweekly', 'monthly'], default: 'none' },
      count: { type: Number },
    },

    tags: [{ type: String, trim: true }],
    attachments: [{ type: String }],
    colour: { type: String, trim: true },
  },
  { timestamps: true }
);

meetingSchema.plugin(softDelete);

// The calendar is a range scan over startAt; the board/list views add status.
meetingSchema.index({ startAt: 1, status: 1 });
meetingSchema.index({ 'client.company': 1, startAt: -1 });
meetingSchema.index({ title: 'text', purpose: 'text', minutes: 'text' });

meetingSchema.pre('save', async function beforeSave(next) {
  if (this.startAt && this.endAt) {
    this.durationMinutes = Math.max(0, Math.round((this.endAt - this.startAt) / 60000));
  }
  if (!this.reference) {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Soft-deleted rows still hold their reference, so count them too.
    const count = await mongoose.model('Meeting').countDocuments({}).setOptions({ withDeleted: true });
    this.reference = `MTG-${yyyymm}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

const Meeting = mongoose.model('Meeting', meetingSchema);

Meeting.MEETING_TYPES = MEETING_TYPES;
Meeting.MEETING_STATUSES = MEETING_STATUSES;

module.exports = Meeting;
