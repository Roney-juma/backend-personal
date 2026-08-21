const mongoose = require('mongoose');

const { Schema } = mongoose;

const claimTokenSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  token: { type: String, required: true, unique: true },
  used: { type: Boolean, default: false },
  // Auto-expire the link. The TTL deletes the doc 30 days AFTER expiresAt rather
  // than at it: if the doc vanished the moment it expired, a late claimant would
  // get "Invalid token" (record not found) instead of an accurate "this link has
  // expired", and a half-finished AI intake transcript would disappear with it.
  expiresAt: { type: Date, index: { expires: '30d' } },

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
