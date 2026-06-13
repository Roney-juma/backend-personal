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
      console.error('Failed to generate/send invoice PDF:', err);
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

const markAsPaid = async (id, paymentData) => {
  return Invoice.findByIdAndUpdate(
    id,
    { status: 'paid', paidDate: new Date(), ...paymentData },
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

  return {
    totalRevenue: stats[0]?.totalRevenue || 0,
    totalPaidInvoices: stats[0]?.count || 0,
    outstandingAmount: outstanding[0]?.total || 0,
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
