const express = require('express');
const router = express.Router();
const controller = require('../controllers/supportTicket.controller');
const verifyToken = require('../middlewheres/verifyToken');

router.post('/', verifyToken(), controller.createTicket);
router.get('/', verifyToken(), controller.getAllTickets);
router.get('/stats', verifyToken(), controller.getTicketStats);
router.get('/company/:companyId', verifyToken(), controller.getTicketsByCompany);
router.get('/:id', verifyToken(), controller.getTicketById);
router.patch('/:id', verifyToken(), controller.updateTicket);
router.post('/:id/message', verifyToken(), controller.addMessage);
router.patch('/:id/assign', verifyToken(), controller.assignTicket);
router.patch('/:id/resolve', verifyToken(), controller.resolveTicket);
router.patch('/:id/close', verifyToken(), controller.closeTicket);

module.exports = router;
