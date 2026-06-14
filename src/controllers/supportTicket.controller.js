const supportTicketService = require('../service/supportTicket.service');

const createTicket = async (req, res) => {
  try {
    const ticket = await supportTicketService.createTicket(req.body);
    res.status(201).json(ticket);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllTickets = async (req, res) => {
  try {
    const result = await supportTicketService.getAllTickets(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTicketById = async (req, res) => {
  try {
    const ticket = await supportTicketService.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.status(200).json(ticket);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTicketsByCompany = async (req, res) => {
  try {
    const tickets = await supportTicketService.getTicketsByCompany(req.params.companyId);
    res.status(200).json(tickets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateTicket = async (req, res) => {
  try {
    const ticket = await supportTicketService.updateTicket(req.params.id, req.body);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.status(200).json(ticket);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const addMessage = async (req, res) => {
  try {
    const ticket = await supportTicketService.addMessage(req.params.id, req.body);
    res.status(200).json(ticket);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const assignTicket = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    const ticket = await supportTicketService.assignTicket(req.params.id, userId);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.status(200).json(ticket);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const resolveTicket = async (req, res) => {
  try {
    const ticket = await supportTicketService.resolveTicket(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.status(200).json(ticket);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const closeTicket = async (req, res) => {
  try {
    const ticket = await supportTicketService.closeTicket(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.status(200).json(ticket);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTicketStats = async (req, res) => {
  try {
    const stats = await supportTicketService.getTicketStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createTicket,
  getAllTickets,
  getTicketById,
  getTicketsByCompany,
  updateTicket,
  addMessage,
  assignTicket,
  resolveTicket,
  closeTicket,
  getTicketStats,
};
