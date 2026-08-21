const mongoose = require('mongoose');
const appendOnly = require('./plugins/appendOnly');
const { LEDGER_ENTRY_TYPES, RESERVE_BUCKETS, LEDGER_STATUS } = require('../constants/legal.constants');

const { Schema } = mongoose;

/**
 * One money movement on a legal matter. Append-only.
 *
 * Spec §16 states the exposure formula outright:
 *   claim + interest + legal costs + court costs + expert costs − recoveries
 *   = net legal exposure
 *
 * Split across mutable fee / payment / recovery / reserve tables, that formula
 * becomes five joins and reserve history is destroyed on every overwrite. As one
 * append-only stream it is a single aggregation, reserves become a running
 * balance, and every figure on the management dashboard traces back to a posting
 * with an actor and a timestamp.
 *
 * Nothing here is ever edited or deleted. A mistake is corrected by posting a
 * reversing entry that points at the original via `reversalOf` — which is what
 * an insurer's auditors will actually test.
 *
 * All amounts are integer minor units (see utils/money.js).
 */
const legalLedgerEntrySchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true, index: true },

    // The accident. Always set, so exposure rolls up per accident even when the
    // entry belongs to one claimant among several.
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },

    // The exposure this money belongs to. Set for everything third-party;
    // null only for matter-level costs on a non-third-party case (a coverage
    // dispute with the insured, say).
    thirdPartyClaim: { type: Schema.Types.ObjectId, ref: 'ThirdPartyClaim', index: true },

    // Set once the matter is in court. Lets costs roll up per suit as well.
    legalCase: { type: Schema.Types.ObjectId, ref: 'LegalCase', index: true },

    entryType: {
      type: String,
      enum: Object.keys(LEDGER_ENTRY_TYPES),
      required: true,
    },

    /**
     * Derived from entryType by the ledger service, never taken from the request:
     * a recovery cannot raise exposure and a court fee cannot lower it.
     */
    direction: { type: String, enum: ['debit', 'credit'], required: true },

    /**
     * Signed for `reserve_adjust` (a reserve can be revised downward without
     * that being a credit); non-negative for everything else.
     */
    amountMinor: { type: Number, required: true },
    currency: { type: String, default: 'KES', uppercase: true },

    // Which reserve this movement affects, for reserve_* entries.
    reserveBucket: { type: String, enum: RESERVE_BUCKETS },

    counterparty: {
      type: {
        type: String,
        enum: ['claimant', 'advocate', 'court', 'expert', 'medical_provider',
               'third_party_insurer', 'driver', 'employer', 'manufacturer', 'garage', 'other'],
      },
      id: { type: Schema.Types.ObjectId },
      name: { type: String },
    },

    // Where this posting came from, so a fee note or settlement can be traced
    // back from the ledger without a text search.
    sourceRef: {
      model: { type: String },
      id: { type: Schema.Types.ObjectId },
    },

    status: { type: String, enum: LEDGER_STATUS, default: 'accrued', index: true },

    description: { type: String },

    // When the money actually moved / the obligation arose — which is not always
    // when we recorded it. Reporting uses this; `postedAt` is the audit fact.
    occurredAt: { type: Date, required: true, default: Date.now },
    postedAt: { type: Date, default: Date.now },
    postedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
    postedByName: { type: String },

    // Set on a reversing entry, pointing at the entry it cancels.
    reversalOf: { type: Schema.Types.ObjectId, ref: 'LegalLedgerEntry', index: true },
    reversalReason: { type: String },
  },
  { timestamps: true }
);

// Per-exposure ledger view, newest first.
legalLedgerEntrySchema.index({ thirdPartyClaim: 1, occurredAt: -1 });
// Per-accident exposure roll-up.
legalLedgerEntrySchema.index({ claim: 1, entryType: 1 });
// Tenant reporting: spend by type over a period.
legalLedgerEntrySchema.index({ company: 1, entryType: 1, occurredAt: -1 });
// Per-suit cost roll-up.
legalLedgerEntrySchema.index({ legalCase: 1, occurredAt: -1 });

/**
 * No softDelete plugin here, deliberately.
 *
 * Soft delete would hide entries from the aggregations that compute exposure,
 * which is precisely the silent-corruption path this collection exists to
 * prevent. Retention purges, when they come, run as an explicit archival job.
 */
legalLedgerEntrySchema.plugin(appendOnly);

module.exports = mongoose.model('LegalLedgerEntry', legalLedgerEntrySchema);
