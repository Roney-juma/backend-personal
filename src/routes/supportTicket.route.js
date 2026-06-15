const express = require('express');
const router = express.Router();
const controller = require('../controllers/supportTicket.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.get('/', verifyProviderToken(), controller.getAllTickets);
router.get('/stats', verifyProviderToken(), controller.getTicketStats);
router.get('/company/:companyId', verifyProviderToken(), controller.getTicketsByCompany);
router.get('/:id', verifyProviderToken(), controller.getTicketById);
router.patch('/:id', verifyProviderToken(), controller.updateTicket);
router.post('/:id/message', verifyProviderToken(), controller.addMessage);
router.patch('/:id/assign', verifyProviderToken(), controller.assignTicket);
router.patch('/:id/resolve', verifyProviderToken(), controller.resolveTicket);
router.patch('/:id/close', verifyProviderToken(), controller.closeTicket);

module.exports = router;
