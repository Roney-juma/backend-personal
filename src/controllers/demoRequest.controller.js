const service = require('../service/demoRequest.service');

const createDemoRequest = async (req, res) => {
  try {
    const { fullName, phoneNumber, email, company, message } = req.body;
    if (!fullName || !phoneNumber || !email) {
      return res.status(400).json({ message: 'fullName, phoneNumber and email are required.' });
    }
    const request = await service.create({ fullName, phoneNumber, email, company, message });
    res.status(201).json({ message: 'Demo request received. We will be in touch within 24 hours.', request });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAllDemoRequests = async (req, res) => {
  try {
    const result = await service.getAll(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getDemoRequestById = async (req, res) => {
  try {
    const request = await service.getById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Demo request not found.' });
    res.status(200).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateDemoRequest = async (req, res) => {
  try {
    const request = await service.update(req.params.id, req.body);
    if (!request) return res.status(404).json({ message: 'Demo request not found.' });
    res.status(200).json(request);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = { createDemoRequest, getAllDemoRequests, getDemoRequestById, updateDemoRequest };
