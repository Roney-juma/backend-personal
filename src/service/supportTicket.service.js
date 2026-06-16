const SupportTicket = require('../models/supportTicket.model');

const createTicket = async (data) => {
  const { company, subject, description, priority, category } = data;
  const ticket = new SupportTicket({ company, subject, description, priority, category });
  return ticket.save();
};

const getAllTickets = async ({ status, priority, category, company, assignedTo, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (priority) filter.priority = priority;
  if (category) filter.category = category;
  if (company) filter.company = company;
  if (assignedTo) filter.assignedTo = assignedTo;
  const skip = (page - 1) * limit;
  const [tickets, total, unreadCounts] = await Promise.all([
    SupportTicket.find(filter)
      .lean()
      .populate('company', 'companyName email')
      .populate('assignedTo', 'fullName email')
      .select('-messages')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    SupportTicket.countDocuments(filter),
    SupportTicket.aggregate([
      { $match: filter },
      {
        $project: {
          unreadCount: {
            $size: {
              $filter: {
                input: '$messages',
                as: 'msg',
                cond: {
                  $and: [
                    { $eq: ['$$msg.sender', 'company'] },
                    { $ne: ['$$msg.isRead', true] },
                  ],
                },
              },
            },
          },
        },
      },
    ]),
  ]);
  const unreadMap = new Map(unreadCounts.map(({ _id, unreadCount }) => [_id.toString(), unreadCount]));
  const ticketsWithUnread = tickets.map((t) => ({ ...t, unreadCount: unreadMap.get(t._id.toString()) ?? 0 }));
  return { tickets: ticketsWithUnread, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getTicketById = async (id) => {
  return SupportTicket.findById(id)
    .populate('company', 'companyName email phone contactPerson')
    .populate('assignedTo', 'fullName email');
};

const getTicketsByCompany = async (companyId) => {
  return SupportTicket.find({ company: companyId })
    .select('-messages')
    .sort({ createdAt: -1 });
};

const updateTicket = async (id, data) => {
  return SupportTicket.findByIdAndUpdate(id, data, { new: true })
    .populate('company', 'companyName email')
    .populate('assignedTo', 'fullName email');
};

const addMessage = async (id, message) => {
  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw new Error('Ticket not found');
  ticket.messages.push({ ...message, sentAt: new Date() });
  if (ticket.status === 'open' && message.sender === 'support') {
    ticket.status = 'in_progress';
  }
  return ticket.save();
};

const markMessagesAsRead = async (id) => {
  return SupportTicket.updateOne(
    { _id: id },
    { $set: { 'messages.$[elem].isRead': true } },
    { arrayFilters: [{ 'elem.sender': 'company' }] }
  );
};

const assignTicket = async (id, userId) => {
  return SupportTicket.findByIdAndUpdate(
    id,
    { assignedTo: userId, status: 'in_progress' },
    { new: true }
  ).populate('assignedTo', 'fullName email');
};

const resolveTicket = async (id) => {
  return SupportTicket.findByIdAndUpdate(
    id,
    { status: 'resolved', resolvedAt: new Date() },
    { new: true }
  );
};

const closeTicket = async (id) => {
  return SupportTicket.findByIdAndUpdate(
    id,
    { status: 'closed', closedAt: new Date() },
    { new: true }
  );
};

const getTicketStats = async () => {
  const stats = await SupportTicket.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]);
  const byPriority = await SupportTicket.aggregate([
    { $match: { status: { $in: ['open', 'in_progress'] } } },
    { $group: { _id: '$priority', count: { $sum: 1 } } },
  ]);
  return { byStatus: stats, byPriority };
};

module.exports = {
  createTicket,
  getAllTickets,
  getTicketById,
  getTicketsByCompany,
  updateTicket,
  addMessage,
  markMessagesAsRead,
  assignTicket,
  resolveTicket,
  closeTicket,
  getTicketStats,
};
