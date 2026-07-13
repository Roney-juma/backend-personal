const assesorController = require("../controllers/assessor.controller")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");
const authLimiter = require("../middlewheres/authLimiter");
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");

const router = express.Router();


router.post('/create',verifyToken(), assesorController.createAssessor)
router.post('/login', authLimiter, assesorController.login)
router.post('/forgot-password', authLimiter, assesorController.forgotPassword);
router.post('/reset-password', authLimiter, assesorController.resetPassword);

// MFA + first-login password change (mobile assessor)
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);
router.post('/mfa/setup', verifyToken(), mfaController.setup('Assessor'));
router.post('/mfa/enable', verifyToken(), mfaController.enable('Assessor'));
router.post('/mfa/disable', verifyToken(), mfaController.disable('Assessor'));
router.post('/change-password', verifyToken(), passwordController.changePassword('Assessor'));
router.get('/stats',verifyToken(), assesorController.getAssessorStatistics)
router.get('/topAssessors',verifyToken(), assesorController.getTopAssessors)
router.get('/',verifyToken(), assesorController.getAllAssessors)
router.get('/approvedClaims/:assessorId',verifyToken(), assesorController.getApprovedClaims)
router.post('/submitReport/:claimId',verifyToken(), assesorController.submitAssessmentReport)
router.delete('/delete/:id',verifyToken(), assesorController.deleteAssessor)
router.post('/complete-reassessment/:id',verifyToken(), assesorController.submitReAssessmentReport)
router.post('/rejectJob/:id',verifyToken(), assesorController.rejectReAssessment)
router.get('/:id',verifyToken(), assesorController.getAssessorById)
router.post('/bid/:claimId',verifyToken(), assesorController.placeBid)
router.put('/:id',verifyToken(), assesorController.updateAssessor)
router.get('/myBids/:assessorId',verifyToken(), assesorController.getAssessorBids)
router.patch('/:id/fcm-token', verifyToken(), assesorController.updateFcmToken)

module.exports = router;