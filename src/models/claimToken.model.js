const mongoose = require('mongoose');

const { Schema } = mongoose;

const claimTokenSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  token: { type: String, required: true, unique: true },
  used: { type: Boolean, default: false },
  // Auto-expire the link. TTL index removes the doc once expiresAt passes.
  expiresAt: { type: Date, index: { expires: 0 } },

  // ── Cross-device resumable AI intake ─────────────────────────────────────
  // The conversational claim-intake state is persisted here after every turn so
  // the claimant can close the link on one device and resume on another without
  // losing progress. `conversation` is the opaque agent message history;
  // `transcript` is the display bubbles ([{ who, text, img }]).
  conversation: { type: Schema.Types.Mixed },
  transcript: { type: [Schema.Types.Mixed], default: undefined },
  intakeStatus: { type: String, enum: ['collecting', 'submitted'], default: 'collecting' },
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim' },
  lastActivityAt: { type: Date },
}, { timestamps: true });

const ClaimToken = mongoose.model('ClaimToken', claimTokenSchema);


module.exports = ClaimToken;
