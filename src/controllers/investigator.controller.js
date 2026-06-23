const investigatorService = require('../service/investigator.service');
const tokenService = require('../service/token.service');
const logger = require('../middlewheres/logger');

const createInvestigator = async (req, res) => {
  try {
    const investigator = await investigatorService.createInvestigator(req.body, req);
    res.status(201).json(investigator);
  } catch (error) {
    logger.error('Error creating investigator: %s', error.message);
    res.status(error.statusCode || 409).json({ message: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await investigatorService.loginWithEmailAndPassword(email, password);
    const tokens = tokenService.GenerateToken(user);
    res.status(200).json({ user, tokens });
  } catch (error) {
    logger.error('Error during investigator login: %s', error.message);
    res.status(error.statusCode || 401).json({ message: error.message });
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

const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const result = await investigatorService.resetPassword(email, newPassword);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
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

const assignInvestigator = async (req, res) => {
  try {
    const { claimId } = req.params;
    const { investigatorId, reason, assignedByType } = req.body;
    const assignedBy = req.user?.id || req.body.assignedBy;

    const investigation = await investigatorService.assignInvestigator(
      claimId, investigatorId, reason, assignedBy, assignedByType || 'insuranceCompany', req
    );
    res.status(201).json(investigation);
  } catch (error) {
    logger.error('Error assigning investigator: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const startInvestigation = async (req, res) => {
  try {
    const investigation = await investigatorService.startInvestigation(req.params.investigationId, req);
    res.status(200).json(investigation);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const submitReport = async (req, res) => {
  try {
    const investigation = await investigatorService.submitInvestigationReport(
      req.params.investigationId, req.body, req
    );
    res.status(200).json(investigation);
  } catch (error) {
    logger.error('Error submitting investigation report: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const reviewReport = async (req, res) => {
  try {
    const { reviewNotes } = req.body;
    const reviewedBy = req.user?.id || req.body.reviewedBy;
    const investigation = await investigatorService.reviewInvestigationReport(
      req.params.investigationId, reviewNotes, reviewedBy, req
    );
    res.status(200).json(investigation);
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

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: 'fcmToken is required' });
    const { updateFcmToken: update } = require('../service/firebase.service');
    await update(req.params.id, 'investigator', fcmToken);
    res.status(200).json({ message: 'FCM token updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createInvestigator,
  login,
  getAllInvestigators,
  getInvestigator,
  updateInvestigator,
  deleteInvestigator,
  resetPassword,
  getStats,
  assignInvestigator,
  startInvestigation,
  submitReport,
  reviewReport,
  getMyInvestigations,
  getAllInvestigations,
  getInvestigation,
  updateFcmToken,
};
