const invoiceService = require('../service/invoice.service');

const createInvoice = async (req, res) => {
  try {
    const invoice = await invoiceService.createInvoice(req.body);
    res.status(201).json(invoice);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllInvoices = async (req, res) => {
  try {
    const result = await invoiceService.getAllInvoices(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const invoice = await invoiceService.getInvoiceById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getInvoicesByCompany = async (req, res) => {
  try {
    const invoices = await invoiceService.getInvoicesByCompany(req.params.companyId);
    res.status(200).json(invoices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateInvoice = async (req, res) => {
  try {
    const invoice = await invoiceService.updateInvoice(req.params.id, req.body);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const markAsSent = async (req, res) => {
  try {
    const invoice = await invoiceService.markAsSent(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const markAsPaid = async (req, res) => {
  try {
    const invoice = await invoiceService.markAsPaid(req.params.id, req.body);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const cancelInvoice = async (req, res) => {
  try {
    const invoice = await invoiceService.cancelInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getRevenueStats = async (req, res) => {
  try {
    const stats = await invoiceService.getRevenueStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const previewPdf = async (req, res) => {
  try {
    const buffer = await invoiceService.getInvoicePdfBuffer(req.params.id);
    if (!buffer) return res.status(404).json({ message: 'Invoice not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice.pdf"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
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
  previewPdf,
};
