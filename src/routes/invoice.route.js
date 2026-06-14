const express = require('express');
const router = express.Router();
const controller = require('../controllers/invoice.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.post('/', verifyProviderToken(), controller.createInvoice);
router.get('/', verifyProviderToken(), controller.getAllInvoices);
router.get('/stats/revenue', verifyProviderToken(), controller.getRevenueStats);
router.get('/company/:companyId', verifyProviderToken(), controller.getInvoicesByCompany);
router.get('/:id/preview', verifyProviderToken(), controller.previewPdf);
router.get('/:id', verifyProviderToken(), controller.getInvoiceById);
router.patch('/:id', verifyProviderToken(), controller.updateInvoice);
router.patch('/:id/send', verifyProviderToken(), controller.markAsSent);
router.patch('/:id/pay', verifyProviderToken(), controller.markAsPaid);
router.patch('/:id/cancel', verifyProviderToken(), controller.cancelInvoice);

module.exports = router;
