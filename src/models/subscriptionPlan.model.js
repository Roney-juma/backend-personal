const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String },
    price: {
      monthly: { type: Number, required: true, min: 0 },
      annually: { type: Number, required: true, min: 0 },
    },
    currency: { type: String, default: 'USD', uppercase: true },
    features: [{ type: String }],
    limits: {
      maxUsers: { type: Number, default: 10 },
      maxClaims: { type: Number, default: 500 },
      maxApiCallsPerMonth: { type: Number, default: 10000 },
      maxStorageGB: { type: Number, default: 10 },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

subscriptionPlanSchema.plugin(softDelete);

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
