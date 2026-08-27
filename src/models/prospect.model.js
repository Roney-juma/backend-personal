const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

/**
 * An insurer we are trying to win.
 *
 * This record holds only what a person decides — the stage, who owns it, what
 * happens next. Everything that can be observed instead of typed (how many
 * demos were held, when we last spoke, what is scheduled next, what is
 * outstanding) is derived from the meetings and tasks that already exist, so
 * nothing is entered twice and the pipeline cannot quietly disagree with the
 * calendar.
 *
 * That split is the whole design. A stage is a judgement; "three demos held" is
 * a fact, and a fact that is typed by hand is a fact that goes stale.
 */

/**
 * Stages a human sets. Deliberately no "demo scheduled" or "demo held" — those
 * are answered by the calendar, and duplicating them here would create two
 * sources of truth that drift apart within a week.
 */
const PROSPECT_STAGES = [
  'new',          // identified, not yet spoken to
  'engaged',      // in conversation
  'evaluating',   // they are assessing us — usually post-demo
  'proposal',     // commercials with them
  'won',
  'lost',
  'dormant',      // no longer being worked, without being a loss
];

const OPEN_STAGES = ['new', 'engaged', 'evaluating', 'proposal'];

const LOST_REASONS = [
  'price', 'missing_features', 'competitor', 'no_budget',
  'timing', 'no_decision', 'internal_build', 'unresponsive', 'other',
];

const prospectSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true },

    /** The insurer's name. Required — a prospect without one cannot be worked. */
    name: { type: String, required: true, trim: true },

    /**
     * Set once they exist on the platform. Until then there is only a name,
     * which is why the name is what meetings are matched on as a fallback.
     */
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true },

    contact: {
      name: { type: String, trim: true },
      title: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
    },

    stage: { type: String, enum: PROSPECT_STAGES, default: 'new', index: true },

    source: {
      type: String,
      enum: ['inbound_request', 'outbound', 'referral', 'event', 'partner', 'other'],
      default: 'outbound',
    },
    // Set when this came from the public "Request a Demo" form.
    demoRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'DemoRequest' },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderUser', index: true },
    ownerName: { type: String, trim: true },

    /**
     * The single most useful field on the record: what happens next and when.
     * A prospect with no next step is how one goes quiet without anyone noticing.
     */
    nextStep: { type: String, trim: true },
    nextStepAt: { type: Date, index: true },

    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true }],

    wonAt: { type: Date },
    lostAt: { type: Date },
    lostReason: { type: String, enum: LOST_REASONS },
    lostNotes: { type: String, trim: true },
  },
  { timestamps: true }
);

prospectSchema.plugin(softDelete);

prospectSchema.index({ stage: 1, updatedAt: -1 });
prospectSchema.index({ name: 'text', notes: 'text' });

prospectSchema.pre('save', async function assignReference(next) {
  if (this.reference) return next();
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const count = await mongoose.model('Prospect').countDocuments({}).setOptions({ withDeleted: true });
  this.reference = `PRO-${yyyymm}-${String(count + 1).padStart(4, '0')}`;
  next();
});

// Keep the outcome timestamps honest without asking callers to set them.
prospectSchema.pre('save', function stampOutcome(next) {
  if (this.isModified('stage')) {
    if (this.stage === 'won' && !this.wonAt) this.wonAt = new Date();
    if (this.stage === 'lost' && !this.lostAt) this.lostAt = new Date();
    if (!['won', 'lost'].includes(this.stage)) {
      this.wonAt = undefined;
      this.lostAt = undefined;
    }
  }
  next();
});

const Prospect = mongoose.model('Prospect', prospectSchema);

Prospect.PROSPECT_STAGES = PROSPECT_STAGES;
Prospect.OPEN_STAGES = OPEN_STAGES;
Prospect.LOST_REASONS = LOST_REASONS;

module.exports = Prospect;
