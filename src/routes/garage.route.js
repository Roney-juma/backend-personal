const garageController = require("../controllers/garage.controller")
const express = require("express")
const verifyToken = require("../middlewheres/verifyToken");

const router = express.Router();

router.post('/login', garageController.login)
router.post('/reset-password', garageController.resetPassword);
router.post('/create', garageController.createGarage)
router.get('/stats', garageController.getGarageStats)
router.get('/topGarages', garageController.getTopGarages)
router.get('/', garageController.getAllGarages)
router.get('/assessedClaims/:garageId', garageController.getAssessedClaims)
router.delete('/delete/:garageId', garageController.deleteGarage)
router.get('/:id', garageController.getGarage)
router.put('/:garageId', garageController.updateGarage)
router.post('/bidClaim/:id', garageController.placeBid)
router.post('/completeJob/:id', garageController.completeRepair)
router.get('/myBids/:garageId', garageController.getGarageBids)

module.exports = router;