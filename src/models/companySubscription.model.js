const mongoose = require('mongoose');

const companySubscriptionSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    billingCycle: { type: String, enum: ['monthly', 'annually'], default: 'monthly' },
    status: {
      type: String,
      enum: ['active', 'cancelled', 'expired', 'trial', 'suspended'],
      default: 'trial',
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    trialEndDate: { type: Date },
    autoRenew: { type: Boolean, default: true },
    nextBillingDate: { type: Date },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanySubscription', companySubscriptionSchema);
