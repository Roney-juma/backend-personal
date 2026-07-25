const express = require('express');
const router = express.Router();
const controller = require('../controllers/vendorInvoice.controller');
const verifyToken = require('../middlewheres/verifyToken');

// All routes use verifyToken — the same JWT used by assessors, garages, suppliers
// (accountType Assessor/Garage/Supplier) and by insurance-company admins
// (accountType InsuranceCompany). Who may do what is enforced per-action in the
// service based on req.user.accountType.

// Vendor submits an invoice for a completed job.
router.post('/', verifyToken(), controller.createInvoice);

// List: vendor sees own invoices; company admin sees invoices billed to them.
router.get('/', verifyToken(), controller.getInvoices);
router.get('/:id', verifyToken(), controller.getInvoiceById);

// Insurance-company admin marks an invoice paid.
router.patch('/:id/pay', verifyToken(), controller.markAsPaid);

// Vendor withdraws their own unpaid invoice.
router.patch('/:id/cancel', verifyToken(), controller.cancelInvoice);

module.exports = router;
