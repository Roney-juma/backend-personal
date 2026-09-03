const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, unique: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true },
    /**
     * The subscription this invoice BILLS — a period already granted, raised by
     * the renewal sweep or by "Bill period". Paying it settles a debt; it does
     * not extend anything, because the term was extended when it was raised.
     */
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanySubscription' },
    /**
     * The plan this invoice SELLS. Set when the invoice exists to put a company
     * onto a plan rather than to bill one they are already on — paying it is
     * what starts or renews their subscription.
     *
     * The distinction matters: without it there was no way to quote a company
     * for a plan and have their access begin when the money arrived. The only
     * options were to create the subscription unpaid and hope, or to create it
     * by hand after spotting the payment.
     */
    purchase: {
      plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
      billingCycle: { type: String, enum: ['monthly', 'annually'], default: 'monthly' },
    },
    items: [invoiceItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    status: {
      type: String,
      enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'],
      default: 'draft',
    },
    issuedDate: { type: Date, default: Date.now },
    dueDate: { type: Date, required: true },
    paidDate: { type: Date },
    paymentMethod: { type: String },
    paymentReference: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

invoiceSchema.pre('save', async function (next) {
  if (!this.invoiceNumber) {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await mongoose.model('Invoice').countDocuments();
    this.invoiceNumber = `INV-${yyyymm}-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
