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
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanySubscription' },
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
