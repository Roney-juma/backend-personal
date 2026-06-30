const mongoose = require('mongoose');

const { Schema } = mongoose;

const claimTokenSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  token: { type: String, required: true, unique: true },
  used: { type: Boolean, default: false },
  // Auto-expire the link. TTL index removes the doc once expiresAt passes.
  expiresAt: { type: Date, index: { expires: 0 } },
}, { timestamps: true });

const ClaimToken = mongoose.model('ClaimToken', claimTokenSchema);


module.exports = ClaimToken;
