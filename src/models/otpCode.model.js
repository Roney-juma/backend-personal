const mongoose = require('mongoose');

// One-time codes for the mobile account-activation flow (contract §2.4).
// Codes are stored as sha256 hashes only. Validity is enforced in code against
// `expiresAt` (10 minutes); the TTL index purges documents one hour AFTER
// `expiresAt` — not at it — because recent docs (including expired/superseded
// ones) are the ledger for the "max 5 sends per destination per hour" limit.
const otpCodeSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany' },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'customer', required: true },
    channel: { type: String, enum: ['email', 'whatsapp'], required: true },
    destination: { type: String, required: true },
    codeHash: { type: String, required: true },
    purpose: { type: String, enum: ['activation'], default: 'activation', required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    // Set when the code is successfully verified (§2.2). The consumed doc then
    // backs the single-use guarantee of the activation token (§2.3): activation
    // deletes it, so a second activate with the same token finds nothing.
    consumedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Purge one hour after expiry (see header comment — keeps the hourly send
// ledger intact while never retaining codes longer than needed).
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
// Live-code lookup: newest non-consumed code per (customer, purpose).
otpCodeSchema.index({ customerId: 1, purpose: 1, createdAt: -1 });
// Hourly send-rate accounting per destination.
otpCodeSchema.index({ destination: 1, createdAt: -1 });

module.exports = mongoose.model('OtpCode', otpCodeSchema);
