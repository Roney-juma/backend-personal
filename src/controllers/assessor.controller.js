const assessorService = require("../service/assessor.service");
const tokenService = require("../service/token.service");
const emailService = require("../service/email.service");

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await assessorService.loginUserWithEmailAndPassword(email, password);
    const tokens = tokenService.GenerateToken(user);
    res.status(200).json({ user, tokens });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createAssessor = async (req, res) => {
  try {
    const assessorData = req.body;
    const userId = req.user._id || req.user.id;
    const newAssessor = await assessorService.createAssessor(assessorData, userId);

    // Send email notification
    await emailService.sendEmailNotification(
      newAssessor.email,
      'Welcome To Ave Insurance',
      `Dear ${newAssessor.name},\n\nYour account has been created.\nUsername: ${newAssessor.email}`
    );

    res.status(201).json(newAssessor);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getAllAssessors = async (req, res) => {
  try {
    const assessors = await assessorService.getAssessors();
    res.status(200).json(assessors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAssessorById = async (req, res) => {
  try {
    const assessor = await assessorService.getAssessorById(req.params.id);
    res.status(200).json(assessor);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateAssessor = async (req, res) => {
  try {
    console.log("here we go 2")
    const userId = req.user._id || req.user.id; 
    const updatedAssessor = await assessorService.updateAssessor(req.params.id, req.body, userId);
    res.status(200).json(updatedAssessor);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deleteAssessor = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id
    await assessorService.deleteAssessor(req.params.id, userId);
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
    const userId = req.user._id || req.user.id; // Extract userId from authenticated user
    const bid = await assessorService.placeBid(claimId, assessorId, amount, description, timeline, userId);
    res.status(201).json({
      message: 'Bid placed successfully',
      bid,
    });
  } catch (error) {
    console.error('Error placing bid:', error.message);
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
    const userId = req.user._id || req.user.id
    const claim = await assessorService.submitAssessmentReport(req.params.claimId, req.body.assessmentReport, userId);
    res.status(200).json({ message: 'Assessment report submitted successfully', claim });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const userId = req.user._id || req.user.id
    const response = await assessorService.resetPassword(email, newPassword, userId);
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const completeReAssessment = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id; // Extract userId from authenticated user
    const claim = await assessorService.completeRepair(req.params.id, userId);
    res.status(200).json(claim);
  } catch (error) {
    console.error('Error completing repair:', error.message);
    res.status(500).json({ message: error.message });
  }
};

const rejectReAssessment = async (req, res) => {
  try {
    const rejectionReason = req.body.rejectionReason;
    const userId = req.user._id || req.user.id; // Extract userId from authenticated user
    const claim = await assessorService.rejectRepair(req.params.id, rejectionReason, userId);
    res.status(200).json(claim);
  } catch (error) {
    console.error('Error completing repair:', error.message);
    res.status(500).json({ message: error.message });
  }
};

const getAssessorStatistics = async (req, res) => {
  try {
    const statistics = await assessorService.getAssessorStatistics(req.params.assessorId);
    res.status(200).json(statistics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTopAssessors = async (req, res) => {
  try {
    const topAssessors = await assessorService.getTopAssessors();
    res.status(200).json(topAssessors);
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
  resetPassword,
  completeReAssessment,
  rejectReAssessment,
  getAssessorStatistics,
  getTopAssessors
};