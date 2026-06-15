const DemoRequest = require('../models/demoRequest.model');

const create = async ({ fullName, phoneNumber, email, company, message }) => {
  const request = new DemoRequest({ fullName, phoneNumber, email, company, message });
  return request.save();
};

const getAll = async ({ status, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  const skip = (page - 1) * limit;
  const [requests, total] = await Promise.all([
    DemoRequest.find(filter)
      .populate('assignedTo', 'fullName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    DemoRequest.countDocuments(filter),
  ]);
  return { requests, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getById = async (id) => DemoRequest.findById(id).populate('assignedTo', 'fullName email');

const update = async (id, data) =>
  DemoRequest.findByIdAndUpdate(id, data, { new: true }).populate('assignedTo', 'fullName email');

module.exports = { create, getAll, getById, update };
