const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

// Line item on a vendor payment invoice (labour, parts, call-out fee, etc.).
const invoiceItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/**
 * VendorInvoice — a *payable* raised BY a service vendor (assessor, garage or
 * supplier) TO the insurance company they worked for, for a specific claim,
 * on completing their work.
 *
 * This is deliberately separate from the `Invoice` model, which is a *receivable*
 * (the AVE platform billing an insurance company for its subscription). Different
 * direction of money, different lifecycle, different approver. It has nothing to
 * do with the provider-fe (platform staff) endpoints.
 */
const vendorInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, unique: true },

    // Who is billing. vendorType drives the dynamic ref on `vendor`.
    vendorType: {
      type: String,
      enum: ['Assessor', 'Garage', 'Supplier'],
      required: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'vendorType',
      index: true,
    },

    // Who pays. Derived from the vendor's own company — never trusted from the
    // request body — so a vendor can only ever bill their own insurer.
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InsuranceCompany',
      required: true,
      index: true,
    },

    // The claim this work relates to. Required: vendors bill per completed job.
    claim: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Claim',
      required: true,
      index: true,
    },

    items: {
      type: [invoiceItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'An invoice must have at least one line item',
      },
    },
    subtotal: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'KES', uppercase: true },

    // Supporting documents (receipts, photos) — image/upload URLs.
    attachments: [{ type: String }],
    notes: { type: String },

    // Lifecycle: submitted -> approved -> paid, or submitted -> rejected.
    // The vendor may also withdraw a submitted/approved invoice (cancelled).
    status: {
      type: String,
      enum: ['submitted', 'approved', 'rejected', 'paid', 'cancelled'],
      default: 'submitted',
      index: true,
    },
    submittedAt: { type: Date, default: Date.now },

    // Admin review (approve/reject) — filled before payment.
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String },

    // Payment settlement (filled by the insurance-company admin on mark-as-paid).
    paidAt: { type: Date },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // the admin User who paid
    paymentMethod: { type: String },
    paymentReference: { type: String },

    cancelledAt: { type: Date },
    cancellationReason: { type: String },
  },
  { timestamps: true }
);

// Common list queries: a company's invoices by status, newest first;
// and a vendor's own invoices by status.
vendorInvoiceSchema.index({ company: 1, status: 1, createdAt: -1 });
vendorInvoiceSchema.index({ vendor: 1, status: 1, createdAt: -1 });

vendorInvoiceSchema.pre('save', async function (next) {
  if (!this.invoiceNumber) {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Count across all docs (including soft-deleted) to avoid number reuse.
    const count = await mongoose
      .model('VendorInvoice')
      .countDocuments({}, { withDeleted: true });
    this.invoiceNumber = `VINV-${yyyymm}-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

vendorInvoiceSchema.plugin(softDelete);

module.exports = mongoose.model('VendorInvoice', vendorInvoiceSchema);
