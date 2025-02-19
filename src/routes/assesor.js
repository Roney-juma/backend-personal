const assesorController = require("../controllers/assessor.controller")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();


router.post('/create',verifyToken(), assesorController.createAssessor)
router.post('/login', assesorController.login)
router.post('/reset-password',verifyToken(), assesorController.resetPassword);
router.get('/stats',verifyToken(), assesorController.getAssessorStatistics)
router.get('/topAssessors',verifyToken(), assesorController.getTopAssessors)
router.get('/',verifyToken(), assesorController.getAllAssessors)
router.get('/approvedClaims/:assessorId',verifyToken(), assesorController.getApprovedClaims)
router.post('/submitReport/:claimId',verifyToken(), assesorController.submitAssessmentReport)
router.delete('/delete/:id',verifyToken(), assesorController.deleteAssessor)
router.post('/completeJob/:id',verifyToken(), assesorController.completeReAssessment)
router.post('/rejectJob/:id',verifyToken(), assesorController.rejectReAssessment)
router.get('/:id',verifyToken(), assesorController.getAssessorById)
router.post('/bid/:claimId',verifyToken(), assesorController.placeBid)
router.put('/:id',verifyToken(), assesorController.updateAssessor)
router.get('/myBids/:assessorId',verifyToken(), assesorController.getAssessorBids)


module.exports = router;