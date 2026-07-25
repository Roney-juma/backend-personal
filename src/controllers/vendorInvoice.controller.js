const vendorInvoiceService = require('../service/vendorInvoice.service');
const logger = require('../middlewheres/logger');

// Vendor (assessor/garage/supplier) submits an invoice for a claim on completing work.
const createInvoice = async (req, res) => {
  try {
    const invoice = await vendorInvoiceService.createInvoice(req);
    res.status(201).json(invoice);
  } catch (error) {
    logger.error('Error creating vendor invoice: %s', error.message);
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// List invoices scoped to the caller (own invoices for vendors, company invoices
// for admins).
const getInvoices = async (req, res) => {
  try {
    const result = await vendorInvoiceService.getInvoices(req);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const invoice = await vendorInvoiceService.getInvoiceById(req, req.params.id);
    res.status(200).json(invoice);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// Company admin marks an invoice as paid.
const markAsPaid = async (req, res) => {
  try {
    const invoice = await vendorInvoiceService.markAsPaid(req, req.params.id, req.body);
    res.status(200).json(invoice);
  } catch (error) {
    logger.error('Error paying vendor invoice: %s', error.message);
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// Vendor withdraws their own invoice before payment.
const cancelInvoice = async (req, res) => {
  try {
    const invoice = await vendorInvoiceService.cancelInvoice(req, req.params.id, req.body);
    res.status(200).json(invoice);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

module.exports = {
  createInvoice,
  getInvoices,
  getInvoiceById,
  markAsPaid,
  cancelInvoice,
};
