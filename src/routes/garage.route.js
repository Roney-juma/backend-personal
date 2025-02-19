const garageController = require("../controllers/garage.controller")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();

router.post('/login', garageController.login)
router.post('/reset-password', garageController.resetPassword);
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

module.exports = router;