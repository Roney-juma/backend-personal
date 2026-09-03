const Invoice = require('../models/invoice.model');
const emailService = require('./email.service');
const generateInvoicePdf = require('../utils/generateInvoicePdf');

const createInvoice = async (data) => {
  const { company, subscription, items, taxRate = 0, dueDate, notes, currency, paymentMethod } = data;

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
    .populate('subscription');
};

const getInvoicesByCompany = async (companyId) => {
  return Invoice.find({ company: companyId }).sort({ createdAt: -1 });
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
 * Record that an invoice has been settled.
 *
 * Reachable from draft, sent and overdue alike. Sending is about whether we
 * emailed the client a PDF; being paid is about whether the money arrived, and
 * gating the second on the first meant recording a payment forced an email the
 * client may neither want nor need — for a proforma settled in advance, or an
 * invoice raised by the renewal sweep that a standing order already covered.
 *
 * `paidDate` is accepted rather than assumed: payments get recorded days after
 * they land, and stamping today's date on a transfer that cleared last Tuesday
 * makes the revenue-by-month figures wrong.
 */
const markAsPaid = async (id, { paymentMethod, paymentReference, paidDate } = {}) => {
  const invoice = await Invoice.findById(id);
  if (!invoice) return null;

  if (invoice.status === 'cancelled') {
    throw new Error('A cancelled invoice cannot be marked paid. Raise a new one instead.');
  }
  // Idempotent: paying twice is a double-click, not a second payment.
  if (invoice.status === 'paid') return invoice;

  const when = paidDate ? new Date(paidDate) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error('Payment date is not a valid date.');

  return Invoice.findByIdAndUpdate(
    id,
    {
      status: 'paid',
      paidDate: when,
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(paymentReference ? { paymentReference } : {}),
    },
    { new: true }
  );
};

const cancelInvoice = async (id) => {
  return Invoice.findByIdAndUpdate(id, { status: 'cancelled' }, { new: true });
};

const getRevenueStats = async () => {
  const stats = await Invoice.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$total' },
        count: { $sum: 1 },
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

  const outstanding = await Invoice.aggregate([
    { $match: { status: { $in: ['sent', 'overdue'] } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
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
    { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
  ]);

  const statusTotals = Object.fromEntries(
    byStatus.map((s) => [s._id, { count: s.count, total: s.total }]),
  );

  // One currency across the collection, or null when they disagree — a sum of
  // mixed currencies is not a figure anyone should put a symbol in front of.
  const currencies = await Invoice.distinct('currency');

  return {
    totalRevenue: stats[0]?.totalRevenue || 0,
    totalPaidInvoices: stats[0]?.count || 0,
    outstandingAmount: outstanding[0]?.total || 0,
    overdueAmount: statusTotals.overdue?.total || 0,
    overdueCount: statusTotals.overdue?.count || 0,
    invoiceCount: byStatus.reduce((sum, s) => sum + s.count, 0),
    statusTotals,
    currency: currencies.length === 1 ? currencies[0] : null,
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
