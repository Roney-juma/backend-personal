const investigatorService = require('../service/investigator.service');
const logger = require('../middlewheres/logger');
const { getRequesterCompany } = require('../utils/requesterCompany');

// ─── Admin: Investigator management ──────────────────────────────────────────
// All admin routes are portal-only (requirePortalUser), so getRequesterCompany
// yields the company user's tenant, or null (global scope) for platform staff.

const createInvestigator = async (req, res) => {
  try {
    // The investigator belongs to the company of the user creating it (ignore
    // any client-supplied company to prevent spoofing). Platform staff → none.
    const company = await getRequesterCompany(req);
    const investigator = await investigatorService.createInvestigator({ ...req.body, company: company || undefined }, req);
    res.status(201).json(investigator);
  } catch (error) {
    logger.error('Error creating investigator: %s', error.message);
    res.status(error.statusCode || 409).json({ message: error.message });
  }
};

const getAllInvestigators = async (req, res) => {
  try {
    const { page = 1, limit = 10, name, city, specialization } = req.query;
    // Company users only see their own company's investigators; staff see all.
    const company = await getRequesterCompany(req);
    const result = await investigatorService.getAllInvestigators({ name, city, specialization, company }, page, limit);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getInvestigator = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const investigator = await investigatorService.getInvestigatorById(req.params.id, company);
    res.status(200).json(investigator);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateInvestigator = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const updated = await investigatorService.updateInvestigator(req.params.id, req.body, req, company);
    res.status(200).json(updated);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

const deleteInvestigator = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    await investigatorService.deleteInvestigator(req.params.id, req, company);
    res.status(200).json({ message: 'Investigator deleted successfully' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getStats = async (req, res) => {
  try {
    const stats = await investigatorService.getInvestigatorStats(await getRequesterCompany(req));
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Admin: Investigation management ─────────────────────────────────────────

const flagClaimAsFraud = async (req, res) => {
  try {
    const { reason, flaggedByType } = req.body;
    const flaggedBy = req.user?.id || req.body.flaggedBy;
    const company = await getRequesterCompany(req);
    const investigation = await investigatorService.flagClaimAsFraud(
      req.params.claimId, reason, flaggedBy, flaggedByType || 'insuranceCompany', req, company
    );
    res.status(201).json(investigation);
  } catch (error) {
    logger.error('Error flagging claim as fraud: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const appointInvestigator = async (req, res) => {
  try {
    const { investigatorId } = req.body;
    const company = await getRequesterCompany(req);
    const investigation = await investigatorService.appointInvestigator(
      req.params.investigationId, investigatorId, req, company
    );
    res.status(200).json(investigation);
  } catch (error) {
    logger.error('Error appointing investigator: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const reviewReport = async (req, res) => {
  try {
    const { decision, reviewNotes } = req.body;
    const reviewedBy = req.user?.id || req.body.reviewedBy;
    const company = await getRequesterCompany(req);
    const result = await investigatorService.reviewInvestigationReport(
      req.params.investigationId, decision, reviewNotes, reviewedBy, req, company
    );
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getMyInvestigations = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const investigations = await investigatorService.getMyInvestigations(req.params.investigatorId, company);
    res.status(200).json(investigations);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getAllInvestigations = async (req, res) => {
  try {
    const investigations = await investigatorService.getAllInvestigations(await getRequesterCompany(req));
    res.status(200).json(investigations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getInvestigation = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const investigation = await investigatorService.getInvestigationById(req.params.investigationId, company);
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

// Investigator submits their report — investigationId from URL, token from body
const submitReport = async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    const { token: _removed, ...report } = req.body;
    const investigation = await investigatorService.submitInvestigationReport(
      req.params.investigationId, token, report, req
    );
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
  flagClaimAsFraud,
  appointInvestigator,
  reviewReport,
  getMyInvestigations,
  getAllInvestigations,
  getInvestigation,
  getReportForm,
  submitReport,
};
