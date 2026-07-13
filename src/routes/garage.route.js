const garageController = require("../controllers/garage.controller")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");
const authLimiter = require("../middlewheres/authLimiter");
const mfaController = require("../controllers/mfa.controller");
const passwordController = require("../controllers/password.controller");

const router = express.Router();

router.post('/login', authLimiter, garageController.login)
router.post('/forgot-password', authLimiter, garageController.forgotPassword);
router.post('/reset-password', authLimiter, garageController.resetPassword);

// MFA + first-login password change (mobile garage)
router.post('/mfa/verify-login', authLimiter, mfaController.verifyLogin);
router.post('/mfa/setup', verifyToken(), mfaController.setup('Garage'));
router.post('/mfa/enable', verifyToken(), mfaController.enable('Garage'));
router.post('/mfa/disable', verifyToken(), mfaController.disable('Garage'));
router.post('/change-password', verifyToken(), passwordController.changePassword('Garage'));
router.post('/create',verifyToken(), garageController.createGarage)
router.get('/stats',verifyToken(), garageController.getGarageStats)
router.get('/topGarages',verifyToken(), garageController.getTopGarages)
router.get('/',verifyToken(), garageController.getAllGarages)
router.get('/assessedClaims/:garageId',verifyToken(), garageController.getAssessedClaims)
router.delete('/delete/:garageId',verifyToken(), garageController.deleteGarage)
router.get('/:id',verifyToken(), garageController.getGarage)
router.put('/:garageId',verifyToken(), garageController.updateGarage)
router.post('/bidClaim/:id',verifyToken(), garageController.placeBid)
router.post('/completeJob/:id',verifyToken(), garageController.completeRepair)
router.get('/myBids/:garageId',verifyToken(), garageController.getGarageBids)
router.patch('/:id/fcm-token', verifyToken(), garageController.updateFcmToken)

module.exports = router;