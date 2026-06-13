const express = require('express');
const router = express.Router();
const controller = require('../controllers/invoice.controller');
const verifyToken = require('../middlewheres/verifyToken');

router.post('/', verifyToken(), controller.createInvoice);
router.get('/', verifyToken(), controller.getAllInvoices);
router.get('/stats/revenue', verifyToken(), controller.getRevenueStats);
router.get('/company/:companyId', verifyToken(), controller.getInvoicesByCompany);
router.get('/:id', verifyToken(), controller.getInvoiceById);
router.patch('/:id', verifyToken(), controller.updateInvoice);
router.patch('/:id/send', verifyToken(), controller.markAsSent);
router.patch('/:id/pay', verifyToken(), controller.markAsPaid);
router.patch('/:id/cancel', verifyToken(), controller.cancelInvoice);

module.exports = router;
