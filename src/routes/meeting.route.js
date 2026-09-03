const express = require('express');
const router = express.Router();
const controller = require('../controllers/meeting.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

// Platform staff only. Mounted under /provider, so every call is also captured
// by providerAuditLogger.
router.use(verifyProviderToken());

// Static paths first — otherwise '/calendar' is swallowed by '/:id'.
router.get('/calendar', controller.getCalendar);
router.get('/summary',  controller.getSummary);
router.get('/options',  controller.getOptions);

router.get('/',    controller.getAllMeetings);
router.post('/',   controller.createMeeting);
router.get('/:id', controller.getMeetingById);
router.patch('/:id', controller.updateMeeting);
router.post('/:id/share', controller.shareMeeting);
router.post('/:id/complete', controller.completeMeeting);
router.delete('/:id', controller.deleteMeeting);

module.exports = router;
