const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewheres/verifyToken');
const SupportTicket = require('../models/supportTicket.model');

// All routes require a valid company user JWT. req.user.id is the company _id.

// Open a new support ticket
router.post('/', verifyToken(), async (req, res) => {
  try {
    const { subject, description, priority, category } = req.body;
    if (!subject || !description) {
      return res.status(400).json({ message: 'subject and description are required.' });
    }
    const ticket = new SupportTicket({
      company: req.user.id,
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
    const { status, priority, page = 1, limit = 20 } = req.query;
    const filter = { company: req.user.id };
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
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      company: req.user.id,
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
    const { message, senderName } = req.body;
    if (!message) return res.status(400).json({ message: 'message is required.' });
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      company: req.user.id,
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
