const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { EVENT_KINDS, EVENT_STATUS } = require('../constants/legal.constants');

const { Schema } = mongoose;

/**
 * One dated obligation: a court date, a filing deadline, a statutory time-bar,
 * or an internal task.
 *
 * Deliberately one collection rather than four. This single stream powers the
 * case diary tab, the cross-case Court Diary screen, the overdue KPI and the
 * reminder scheduler — four features off one index — and, critically, it means a
 * statutory limitation date rides exactly the same reminder and escalation
 * machinery as a mention. Time-bar is the cheapest way to lose a defence and the
 * easiest thing to automate, so it must not be a special case that someone
 * remembers to check.
 *
 * An event can hang off a LegalCase (court dates) OR directly off a
 * ThirdPartyClaim (limitation clocks, which exist long before any suit).
 */

/**
 * Record of a reminder actually sent, so the scheduler is idempotent: a restart,
 * a retry or a second worker cannot re-notify for an offset already delivered.
 */
const reminderSentSchema = new Schema(
  {
    offsetDays: { type: Number, required: true },
    sentAt: { type: Date, default: Date.now },
    channels: [{ type: String }],
    recipients: [{ type: Schema.Types.ObjectId }],
  },
  { _id: false }
);

const escalationSchema = new Schema(
  {
    rung: { type: Number, required: true },
    role: { type: String, required: true },
    notifiedAt: { type: Date, default: Date.now },
    acknowledgedAt: { type: Date },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
  },
  { _id: false }
);

const legalEventSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },

    // At least one of these is always set — see the validator below.
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },
    thirdPartyClaim: { type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim', index: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', index: true },

    kind: { type: String, enum: Object.values(EVENT_KINDS), required: true, index: true },

    /**
     * Free-form by design, validated against the tenant's configured event types
     * rather than a schema enum — legal officers add their own deadline types
     * (taxation of costs, mediation, statutory notices) and the system reminds
     * on them identically. See LegalConfig.eventTypes.
     */
    eventType: { type: String, required: true },

    title: { type: String, required: true },
    description: { type: String },

    dueAt: { type: Date, required: true, index: true },
    allDay: { type: Boolean, default: true },

    court: { type: String },
    courtStation: { type: String },

    // Responsibility can sit with our staff, our panel advocate, or a role
    // (nobody in particular yet) — hence the polymorphic reference.
    responsibleType: { type: String, enum: ['Users', 'Advocate', 'Role'] },
    responsible: { type: Schema.Types.ObjectId },
    responsibleRole: { type: String },

    status: { type: String, enum: EVENT_STATUS, default: 'scheduled', index: true },
    outcome: { type: String },

    /**
     * Adjournment links, not mutation.
     *
     * Matters are adjourned constantly. Moving `dueAt` in place would silently
     * erase the history that advocate-performance and court-performance
     * reporting depend on — "this court adjourned us four times" is exactly the
     * insight the module is meant to surface. So an adjournment closes this
     * event and creates a linked successor.
     */
    adjournedFrom: { type: Schema.Types.ObjectId, ref: 'LegalEvent' },
    adjournedTo: { type: Schema.Types.ObjectId, ref: 'LegalEvent' },
    adjournmentReason: { type: String },

    // Resolved from tenant config at creation, so changing the tenant's ladder
    // later does not retroactively rewrite what an in-flight event promised.
    reminderOffsets: { type: [Number], default: [] },
    remindersSent: { type: [reminderSentSchema], default: [] },
    lastOverdueReminderAt: { type: Date },

    escalations: { type: [escalationSchema], default: [] },
    escalationRung: { type: Number, default: 0 },

    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: 'Users' },

    // Who created it — an advocate entering a court date from the portal is a
    // materially different provenance from a system-generated time-bar.
    source: {
      type: String,
      enum: ['legal_officer', 'advocate_portal', 'system', 'import'],
      default: 'legal_officer',
    },
    createdBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// An orphan event can never be actioned, and would sit invisible on every screen.
legalEventSchema.pre('validate', function requireOwner(next) {
  if (!this.legalCase && !this.thirdPartyClaim && !this.claim) {
    return next(new Error('A legal event must belong to a legal case, a third-party claim, or a claim'));
  }
  next();
});

// The scheduler's sweep and the cross-case Court Diary both run on this.
legalEventSchema.index({ company: 1, dueAt: 1, status: 1 });
// The reminder sweep: open events due within the ladder's widest offset.
legalEventSchema.index({ status: 1, dueAt: 1 });
// "My upcoming actions" for a staff member or advocate.
legalEventSchema.index({ responsible: 1, status: 1, dueAt: 1 });

legalEventSchema.plugin(softDelete);

module.exports = mongoose.model('LegalEvent', legalEventSchema);
