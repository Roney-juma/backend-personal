const service = require('../service/prospect.service');
const Prospect = require('../models/prospect.model');
const demoRequestService = require('../service/demoRequest.service');

const createProspect = async (req, res) => {
  try {
    res.status(201).json(await service.create(req.body, req.user));
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

const getAllProspects = async (req, res) => {
  try {
    res.status(200).json(await service.getAll(req.query));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getProspectById = async (req, res) => {
  try {
    const result = await service.getById(req.params.id);
    if (!result) return res.status(404).json({ message: 'Prospect not found.' });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateProspect = async (req, res) => {
  try {
    const prospect = await service.update(req.params.id, req.body);
    if (!prospect) return res.status(404).json({ message: 'Prospect not found.' });
    res.status(200).json(prospect);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteProspect = async (req, res) => {
  try {
    const removed = await service.remove(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Prospect not found.' });
    res.status(200).json({ message: 'Prospect removed.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getSummary = async (req, res) => {
  try {
    res.status(200).json(await service.summary());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Promote an inbound demo request into the pipeline. The request itself stays
 * as the record of how they reached us and is marked contacted.
 */
const convertDemoRequest = async (req, res) => {
  try {
    const request = await demoRequestService.getById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Demo request not found.' });

    const prospect = await service.fromDemoRequest(request, req.user);
    if (request.status === 'new') {
      await demoRequestService.update(request._id, { status: 'contacted' });
    }
    res.status(201).json(prospect);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

const getOptions = (req, res) => {
  res.status(200).json({
    stages: Prospect.PROSPECT_STAGES,
    openStages: Prospect.OPEN_STAGES,
    lostReasons: Prospect.LOST_REASONS,
  });
};

module.exports = {
  createProspect,
  getAllProspects,
  getProspectById,
  updateProspect,
  deleteProspect,
  getSummary,
  convertDemoRequest,
  getOptions,
};
