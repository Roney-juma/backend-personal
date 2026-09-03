const Invoice = require('../models/invoice.model');
const emailService = require('./email.service');
const generateInvoicePdf = require('../utils/generateInvoicePdf');

/**
 * Money, to the cent. Instalments are compared against a balance, and floating
 * point makes 45000 - 15000 - 15000 - 15000 come to a shade below zero — which
 * would leave a fully paid invoice showing a fraction outstanding forever.
 */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const createInvoice = async (data) => {
  const { company, subscription, purchase, items, taxRate = 0, dueDate, notes, currency, paymentMethod } = data;

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const tax = parseFloat(((subtotal * taxRate) / 100).toFixed(2));
  const total = parseFloat((subtotal + tax).toFixed(2));

  const itemsWithTotal = items.map(item => ({
    ...item,
    total: parseFloat((item.quantity * item.unitPrice).toFixed(2)),
  }));

  const invoice = new Invoice({
    company,
    subscription,
    // Only stored when a plan is actually being sold — see the model for the
    // difference between billing an existing subscription and selling a new one.
    purchase: purchase?.plan
      ? { plan: purchase.plan, billingCycle: purchase.billingCycle || 'monthly' }
      : undefined,
    items: itemsWithTotal,
    subtotal,
    taxRate,
    tax,
    total,
    currency: currency || 'USD',
    dueDate: new Date(dueDate),
    notes,
    paymentMethod,
  });

  return invoice.save();
};

const getAllInvoices = async ({ status, company, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (company) filter.company = company;
  const skip = (page - 1) * limit;
  const [invoices, total] = await Promise.all([
    Invoice.find(filter)
      .populate('company', 'companyName email')
      .populate('subscription', 'billingCycle')
      .populate('purchase.plan', 'name currency price')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Invoice.countDocuments(filter),
  ]);
  return { invoices, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getInvoiceById = async (id) => {
  return Invoice.findById(id)
    .populate('company', 'companyName email address')
    .populate('subscription')
    .populate('purchase.plan', 'name currency price');
};

const getInvoicesByCompany = async (companyId) => {
  return Invoice.find({ company: companyId })
    .populate('purchase.plan', 'name')
    .sort({ createdAt: -1 });
};

const updateInvoice = async (id, data) => {
  return Invoice.findByIdAndUpdate(id, data, { new: true }).populate('company', 'companyName email');
};

const markAsSent = async (id) => {
  const invoice = await Invoice.findByIdAndUpdate(id, { status: 'sent' }, { new: true })
    .populate('company', 'companyName email contactPerson');

  if (invoice?.company?.email) {
    try {
      const pdfBuffer = await generateInvoicePdf(invoice);
      const filename = `Invoice-${invoice.invoiceNumber}.pdf`;
      const dueDateStr = new Date(invoice.dueDate).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
      const body = `Dear ${invoice.company.companyName},\n\nPlease find your invoice #${invoice.invoiceNumber} attached.\n\nAmount Due : ${invoice.currency} ${invoice.total.toFixed(2)}\nDue Date   : ${dueDateStr}\n\nPlease ensure payment is made by the due date.\n\nThank you,\nAVE Provider Platform`;
      emailService.sendInvoiceEmail(
        invoice.company.email,
        `Invoice ${invoice.invoiceNumber} — Payment Due ${dueDateStr}`,
        body,
        pdfBuffer,
        filename
      ).catch(() => {});
    } catch (err) {
      require('../middlewheres/logger').error('Failed to generate/send invoice PDF: %s', err.message);
    }
  }

  return invoice;
};

const getInvoicePdfBuffer = async (id) => {
  const invoice = await Invoice.findById(id)
    .populate('company', 'companyName email address');
  if (!invoice) return null;
  return generateInvoicePdf(invoice);
};

/**
 * Record a payment against an invoice — in full, or as one instalment of
 * several.
 *
 * Reachable from draft, sent, overdue and partially paid alike. Sending is
 * about whether we emailed the client a PDF; being paid is about whether the
 * money arrived, and gating the second on the first meant recording a payment
 * forced an email the client may neither want nor need — for a proforma settled
 * in advance, or an invoice raised by the renewal sweep that a standing order
 * already covered.
 *
 * Omit `amount` to settle the balance, which is what most payments are. Pass one
 * to record a batch: a company clearing an annual plan across three transfers
 * gets three rows, each with its own reference and date, which is what makes
 * them reconcilable against a bank statement.
 *
 * `paidDate` is accepted rather than assumed: payments get recorded days after
 * they land, and stamping today's date on a transfer that cleared last Tuesday
 * makes the revenue-by-month figures wrong. `nextPaymentDate` records what was
 * agreed for the rest, and holds off the overdue sweep until it passes.
 */
const markAsPaid = async (id, { paymentMethod, paymentReference, paidDate, amount, nextPaymentDate, note } = {}) => {
  const invoice = await Invoice.findById(id);
  if (!invoice) return null;

  if (invoice.status === 'cancelled') {
    throw new Error('A cancelled invoice cannot be marked paid. Raise a new one instead.');
  }
  // Idempotent: settling an already-settled invoice is a double-click, not a
  // second payment. A PART-paid invoice is not settled, so it falls through.
  if (invoice.status === 'paid') return invoice;

  const when = paidDate ? new Date(paidDate) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error('Payment date is not a valid date.');

  const alreadyPaid = invoice.amountPaid ?? 0;
  const balance = round2(invoice.total - alreadyPaid);

  /**
   * No amount means "settle the balance", which is what the old single-payment
   * behaviour did and what most payments still are. An amount means an
   * instalment — a company paying an annual plan across three transfers.
   */
  const paying = amount === undefined || amount === null ? balance : round2(Number(amount));
  if (!Number.isFinite(paying) || paying <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }
  if (paying > balance) {
    throw new Error(
      `That is more than the ${invoice.currency} ${balance.toFixed(2)} outstanding on this invoice.`,
    );
  }

  const paidToDate = round2(alreadyPaid + paying);
  const settled = paidToDate >= invoice.total;

  invoice.payments.push({
    amount: paying,
    method: paymentMethod,
    reference: paymentReference,
    paidAt: when,
    note,
  });
  invoice.amountPaid = paidToDate;
  invoice.status = settled ? 'paid' : 'partially_paid';
  // `paidDate` means "settled on", so it is only stamped once the balance is
  // clear. A part-paid invoice has instalment dates, not a settlement date.
  invoice.paidDate = settled ? when : undefined;
  // Latest instalment's details, for the PDF and the list.
  if (paymentMethod) invoice.paymentMethod = paymentMethod;
  if (paymentReference) invoice.paymentReference = paymentReference;
  // An agreed next date only makes sense while something is still owed.
  invoice.nextPaymentDate = settled ? undefined : nextPaymentDate ? new Date(nextPaymentDate) : invoice.nextPaymentDate;

  await invoice.save();
  const paid = await Invoice.findById(id);

  // Access follows full settlement, not the first instalment: activating on a
  // part payment would hand over a year of the platform for a third of the
  // money, and there is no revocation path if the rest never arrives.
  if (!settled) return paid;

  /**
   * An invoice raised to SELL a plan starts the subscription now that the money
   * has arrived. This is the join the billing module was missing: you could
   * quote a company for a plan, but nothing connected their payment to their
   * access, so somebody had to notice and key it in.
   *
   * `subscription` (billing an existing term) deliberately does NOT do this —
   * that term was already granted when the invoice was raised, and extending it
   * again on payment would give away a free period every cycle.
   *
   * Guarded by the idempotent early return above, so activation happens once per
   * invoice however many times this is called.
   */
  if (paid?.purchase?.plan) {
    try {
      const subscriptionService = require('./companySubscription.service');
      const subscription = await subscriptionService.activateFromPayment({
        company: paid.company,
        plan: paid.purchase.plan,
        billingCycle: paid.purchase.billingCycle,
        startAt: when,
      });
      if (subscription) {
        // Link them, so the invoice and the access it bought can be traced
        // to each other from either end.
        paid.subscription = subscription._id;
        await paid.save();
      }
    } catch (err) {
      // The payment is recorded either way — losing that because activation
      // failed would be far worse than an unactivated subscription somebody
      // can start by hand.
      require('../middlewheres/logger').error(
        `[invoice] ${paid.invoiceNumber} paid but subscription activation failed: ${err.message}`,
      );
    }
  }

  return paid;
};

const cancelInvoice = async (id) => {
  return Invoice.findByIdAndUpdate(id, { status: 'cancelled' }, { new: true });
};

const getRevenueStats = async () => {
  /**
   * Collected money, which is the sum of instalments actually received across
   * every live invoice — not the face value of settled ones. With part payments
   * those differ: a company three quarters of the way through an annual plan
   * has paid real money that belongs in this figure.
   */
  const stats = await Invoice.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: { $ifNull: ['$amountPaid', 0] } },
        count: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
      },
    },
  ]);

  const monthly = await Invoice.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: { year: { $year: '$paidDate' }, month: { $month: '$paidDate' } },
        revenue: { $sum: '$total' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': -1, '_id.month': -1 } },
    { $limit: 12 },
  ]);

  // What is still owed — the balance, not the face value, so an invoice that is
  // half settled counts for half.
  const outstanding = await Invoice.aggregate([
    { $match: { status: { $in: ['sent', 'overdue', 'partially_paid'] } } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$total', { $ifNull: ['$amountPaid', 0] }] } } } },
  ]);

  /**
   * Every status, counted and totalled across the whole collection.
   *
   * The portal used to derive its headline figures from whatever page of
   * invoices it happened to be holding — which is 20 by default — so "total
   * revenue" quietly meant "revenue among the twenty most recent". Aggregating
   * here is both correct and cheaper than shipping every invoice to do it.
   */
  const byStatus = await Invoice.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        total: { $sum: '$total' },
        // Balance as well as face value: "overdue" should report what is still
        // owed, which is the figure anyone chasing it actually needs.
        outstanding: { $sum: { $subtract: ['$total', { $ifNull: ['$amountPaid', 0] }] } },
      },
    },
  ]);

  const statusTotals = Object.fromEntries(
    byStatus.map((s) => [s._id, { count: s.count, total: s.total, outstanding: s.outstanding }]),
  );

  // One currency across the collection, or null when they disagree — a sum of
  // mixed currencies is not a figure anyone should put a symbol in front of.
  const currencies = await Invoice.distinct('currency');

  return {
    totalRevenue: stats[0]?.totalRevenue || 0,
    totalPaidInvoices: stats[0]?.count || 0,
    outstandingAmount: outstanding[0]?.total || 0,
    overdueAmount: statusTotals.overdue?.outstanding || 0,
    overdueCount: statusTotals.overdue?.count || 0,
    invoiceCount: byStatus.reduce((sum, s) => sum + s.count, 0),
    statusTotals,
    currency: currencies.length === 1 ? currencies[0] : null,
    partiallyPaidCount: statusTotals.partially_paid?.count || 0,
    monthlyRevenue: monthly,
  };
};

module.exports = {
  createInvoice,
  getAllInvoices,
  getInvoiceById,
  getInvoicesByCompany,
  updateInvoice,
  markAsSent,
  markAsPaid,
  cancelInvoice,
  getRevenueStats,
  getInvoicePdfBuffer,
};
