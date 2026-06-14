const mongoose = require('mongoose');

const apiKeySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true },
    keyName: { type: String, required: true, trim: true },
    keyPrefix: { type: String, required: true },
    keyHash: { type: String, required: true },
    permissions: [{ type: String }],
    status: { type: String, enum: ['active', 'revoked', 'expired'], default: 'active' },
    expiresAt: { type: Date },
    lastUsedAt: { type: Date },
    usageCount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ApiKey', apiKeySchema);
