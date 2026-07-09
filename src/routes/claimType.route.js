const express = require('express');
const claimTypeController = require('../controllers/claimType.controller');
const verifyToken = require('../middlewheres/verifyToken');

const router = express.Router();

router.get('/', claimTypeController.getAllClaimTypes);

router.use(verifyToken());

router.post('/', claimTypeController.createClaimType);
router.get('/:id', claimTypeController.getClaimTypeById);
router.patch('/:id', claimTypeController.updateClaimType);
router.delete('/:id', claimTypeController.deleteClaimType);

module.exports = router;
