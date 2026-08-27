const express = require('express');
const router = express.Router();
const controller = require('../controllers/prospect.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

// Platform staff only. Mounted under /provider, so every call is audit-logged.
router.use(verifyProviderToken());

// Static paths first — otherwise '/summary' is swallowed by '/:id'.
router.get('/summary', controller.getSummary);
router.get('/options', controller.getOptions);

// Promote an inbound demo request into the pipeline.
router.post('/from-demo-request/:id', controller.convertDemoRequest);

router.get('/',    controller.getAllProspects);
router.post('/',   controller.createProspect);
router.get('/:id', controller.getProspectById);
router.patch('/:id', controller.updateProspect);
router.delete('/:id', controller.deleteProspect);

module.exports = router;
