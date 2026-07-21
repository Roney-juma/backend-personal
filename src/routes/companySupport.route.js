const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewheres/verifyToken');
const SupportTicket = require('../models/supportTicket.model');
const { getRequesterCompany } = require('../utils/requesterCompany');

// Tickets belong to an InsuranceCompany. Two caller types may touch them:
// the company-level login (token id IS the company id) and insurer-portal
// admins (tenant claim in the token, incl. legacy ProviderUser-stamped ones
// via the DB fallback). Mobile actors and AVE staff are rejected — staff
// manage tickets through /provider/support instead.
const resolveTicketCompany = async (req) => {
  const type = req.user?.accountType;
  if (type === 'InsuranceCompany') return req.user.id;
  if (type !== 'CompanyUser' && type !== 'User' && type !== 'ProviderUser') return null;
  return getRequesterCompany(req);
};

const requireTicketCompany = async (req, res) => {
  const company = await resolveTicketCompany(req);
  if (!company) {
    res.status(403).json({ message: 'Forbidden: company accounts only' });
    return null;
  }
  return company;
};

// Open a new support ticket
router.post('/', verifyToken(), async (req, res) => {
  try {
    const company = await requireTicketCompany(req, res);
    if (!company) return;
    const { subject, description, priority, category } = req.body;
    if (!subject || !description) {
      return res.status(400).json({ message: 'subject and description are required.' });
    }
    const ticket = new SupportTicket({
      company,
      subject,
      description,
      priority,
      category,
    });
    await ticket.save();
    res.status(201).json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// List own tickets
router.get('/', verifyToken(), async (req, res) => {
  try {
    const company = await requireTicketCompany(req, res);
    if (!company) return;
    const { status, priority, page = 1, limit = 20 } = req.query;
    const filter = { company };
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    const skip = (Number(page) - 1) * Number(limit);
    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .select('-messages')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      SupportTicket.countDocuments(filter),
    ]);
    res.json({ tickets, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// View a single ticket — includes full message thread with provider replies
router.get('/:id', verifyToken(), async (req, res) => {
  try {
    const company = await requireTicketCompany(req, res);
    if (!company) return;
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      company,
    }).populate('assignedTo', 'fullName email');
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Reply to a ticket thread
router.post('/:id/message', verifyToken(), async (req, res) => {
  try {
    const company = await requireTicketCompany(req, res);
    if (!company) return;
    const { message, senderName } = req.body;
    if (!message) return res.status(400).json({ message: 'message is required.' });
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      company,
    });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      return res.status(400).json({ message: 'Cannot reply to a resolved or closed ticket.' });
    }
    ticket.messages.push({ sender: 'company', senderName, message, sentAt: new Date() });
    await ticket.save();
    res.json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
