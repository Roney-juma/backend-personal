const investigatorService = require('../service/investigator.service');
const logger = require('../middlewheres/logger');

// ─── Admin: Investigator management ──────────────────────────────────────────

const createInvestigator = async (req, res) => {
  try {
    const investigator = await investigatorService.createInvestigator(req.body, req);
    res.status(201).json(investigator);
  } catch (error) {
    logger.error('Error creating investigator: %s', error.message);
    res.status(error.statusCode || 409).json({ message: error.message });
  }
};

const getAllInvestigators = async (req, res) => {
  try {
    const { page = 1, limit = 10, name, city, specialization } = req.query;
    const result = await investigatorService.getAllInvestigators({ name, city, specialization }, page, limit);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getInvestigator = async (req, res) => {
  try {
    const investigator = await investigatorService.getInvestigatorById(req.params.id);
    res.status(200).json(investigator);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateInvestigator = async (req, res) => {
  try {
    const updated = await investigatorService.updateInvestigator(req.params.id, req.body, req);
    res.status(200).json(updated);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

const deleteInvestigator = async (req, res) => {
  try {
    await investigatorService.deleteInvestigator(req.params.id, req);
    res.status(200).json({ message: 'Investigator deleted successfully' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getStats = async (req, res) => {
  try {
    const stats = await investigatorService.getInvestigatorStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Admin: Investigation management ─────────────────────────────────────────

const assignInvestigator = async (req, res) => {
  try {
    const { investigatorId, reason, assignedByType } = req.body;
    const assignedBy = req.user?.id || req.body.assignedBy;
    const investigation = await investigatorService.assignInvestigator(
      req.params.claimId, investigatorId, reason, assignedBy, assignedByType || 'insuranceCompany', req
    );
    res.status(201).json(investigation);
  } catch (error) {
    logger.error('Error assigning investigator: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const reviewReport = async (req, res) => {
  try {
    const { reviewNotes } = req.body;
    const reviewedBy = req.user?.id || req.body.reviewedBy;
    const result = await investigatorService.reviewInvestigationReport(
      req.params.investigationId, reviewNotes, reviewedBy, req
    );
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getMyInvestigations = async (req, res) => {
  try {
    const investigations = await investigatorService.getMyInvestigations(req.params.investigatorId);
    res.status(200).json(investigations);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getAllInvestigations = async (req, res) => {
  try {
    const investigations = await investigatorService.getAllInvestigations();
    res.status(200).json(investigations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getInvestigation = async (req, res) => {
  try {
    const investigation = await investigatorService.getInvestigationById(req.params.investigationId);
    res.status(200).json(investigation);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// ─── Public: Token-based investigator access (no login required) ──────────────

// Investigator opens their email link — returns claim + investigation details
const getReportForm = async (req, res) => {
  try {
    const investigation = await investigatorService.getInvestigationByToken(req.params.token);
    res.status(200).json(investigation);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

// Investigator submits their report via the secure link token
const submitReport = async (req, res) => {
  try {
    const investigation = await investigatorService.submitInvestigationReport(req.params.token, req.body, req);
    res.status(200).json(investigation);
  } catch (error) {
    logger.error('Error submitting investigation report: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

module.exports = {
  createInvestigator,
  getAllInvestigators,
  getInvestigator,
  updateInvestigator,
  deleteInvestigator,
  getStats,
  assignInvestigator,
  reviewReport,
  getMyInvestigations,
  getAllInvestigations,
  getInvestigation,
  getReportForm,
  submitReport,
};
