const assessorService = require("../service/assessor.service");
const tokenService = require("../service/token.service");
const emailService = require("../service/email.service");
const { DEFAULT_TEMP_PASSWORD } = require('../constants/userDefaults');
const logger = require('../middlewheres/logger');
  const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await assessorService.loginUserWithEmailAndPassword(email, password);
    if (user.mfaEnabled) {
      const mfaToken = tokenService.generateMfaChallengeToken(user._id, 'Assessor');
      return res.status(200).json({ mfaRequired: true, mfaToken });
    }
    const tokens = tokenService.GenerateToken(user);
    res.status(200).json({ user, tokens });
  } catch (error) {
    if (error.code === 'ACCOUNT_LOCKED') {
      return res.status(429).json({ message: error.message });
    }
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createAssessor = async (req, res) => {
  try {
    // Resolve the credential HERE so the welcome email always carries the real
    // value — the portal may omit password, in which case the default applies.
    const rawPassword = req.body.password || DEFAULT_TEMP_PASSWORD;
    // The assessor belongs to the company of the user creating it (ignore any
    // client-supplied company to prevent spoofing). Platform staff → no company.
    const company = await getRequesterCompany(req);
    const newAssessor = await assessorService.createAssessor({ ...req.body, password: rawPassword, company: company || undefined }, req);

    await emailService.sendEmailNotification(
      newAssessor.email,
      'Welcome To AVE Insurance',
      `Dear ${newAssessor.name},\n\nYour account has been created on the AVE Insurance platform.\n\nLogin Details:\n  Email:    ${newAssessor.email}\n  Password: ${rawPassword}\n  Role:     ${newAssessor.accountType}\n\nPlease log in and change your password at your earliest convenience.\n\nRegards,\nThe AVE Insurance Team`
    );

    res.status(201).json(newAssessor);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getAllAssessors = async (req, res) => {
  try {
    const { page, limit, search } = req.query;
    // Company users only see their own company's assessors; platform staff see all.
    const company = await getRequesterCompany(req);
    const assessors = await assessorService.getAssessors({ page, limit, search, company });
    res.status(200).json(assessors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAssessorById = async (req, res) => {
  try {
    const assessor = await assessorService.getAssessorById(req.params.id);
    // A company user may only view their own company's assessors.
    const company = await getRequesterCompany(req);
    if (!belongsToCompany(assessor.company, company)) {
      return res.status(404).json({ message: 'Assessor not found' });
    }
    res.status(200).json(assessor);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateAssessor = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const updatedAssessor = await assessorService.updateAssessor(req.params.id, req.body, req, company);
    res.status(200).json(updatedAssessor);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deleteAssessor = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    await assessorService.deleteAssessor(req.params.id, req, company);
    res.status(200).json({ message: 'Assessor deleted successfully' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getApprovedClaims = async (req, res) => {
  try {
    const claims = await assessorService.getApprovedClaims(req.params.assessorId);
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const placeBid = async (req, res) => {
  const { claimId } = req.params;
  const { assessorId, amount, description, timeline } = req.body;

  try {
    const bid = await assessorService.placeBid(claimId, assessorId, amount, description, timeline, req);
    res.status(201).json({ message: 'Bid placed successfully', bid });
  } catch (error) {
    logger.error('Error placing assessor bid: %s', error.message);
    res.status(500).json({ error: error.message });
  }
};

const getAssessorBids = async (req, res) => {
  try {
    const bids = await assessorService.getAssessorBids(req.params.assessorId);
    res.status(200).json(bids);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const submitAssessmentReport = async (req, res) => {
  try {
    const claim = await assessorService.submitAssessmentReport(req.params.claimId, req.body.assessmentReport, req);
    res.status(200).json({ message: 'Assessment report submitted successfully', claim });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const response = await assessorService.forgotPassword(email);
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Email, token and newPassword are required' });
    }
    const response = await assessorService.resetPassword(email, token, newPassword);
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const submitReAssessmentReport = async (req, res) => {
  try {
    const { notes, photos, outcome } = req.body;
    if (!notes) return res.status(400).json({ message: 'notes is required' });
    if (!outcome) return res.status(400).json({ message: 'outcome is required (Passed or Failed)' });
    const assessorId = req.user?.id || req.user?._id || null;
    const claim = await assessorService.submitReAssessmentReport(req.params.id, { notes, photos, outcome, assessorId }, req);
    res.status(200).json(claim);
  } catch (error) {
    logger.error('Error submitting re-assessment report: %s', error.message);
    res.status(500).json({ message: error.message });
  }
};

const rejectReAssessment = async (req, res) => {
  try {
    const rejectionReason = req.body.rejectionReason;
    const claim = await assessorService.rejectRepair(req.params.id, rejectionReason, req);
    res.status(200).json(claim);
  } catch (error) {
    logger.error('Error rejecting re-assessment: %s', error.message);
    res.status(500).json({ message: error.message });
  }
};

const getAssessorStatistics = async (req, res) => {
  try {
    // Company users only see their own company's stats; platform staff see all.
    const statistics = await assessorService.getAssessorStatistics(await getRequesterCompany(req));
    res.status(200).json(statistics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTopAssessors = async (req, res) => {
  try {
    const topAssessors = await assessorService.getTopAssessors(await getRequesterCompany(req));
    res.status(200).json(topAssessors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: 'fcmToken is required' });
    const { updateFcmToken: update } = require('../service/firebase.service');
    await update(req.params.id, 'assessor', fcmToken);
    res.status(200).json({ message: 'FCM token updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  login,
  createAssessor,
  getAllAssessors,
  getAssessorById,
  updateAssessor,
  deleteAssessor,
  getApprovedClaims,
  placeBid,
  getAssessorBids,
  submitAssessmentReport,
  forgotPassword,
  resetPassword,
  submitReAssessmentReport,
  rejectReAssessment,
  getAssessorStatistics,
  getTopAssessors,
  updateFcmToken,
};
