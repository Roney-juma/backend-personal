const express = require('express');
const notificationController = require('../controllers/notification.controller');

const router = express.Router();

router.post('/', notificationController.createNotification);
router.get('/:recipientId', notificationController.getNotifications);
router.put('/:id/read', notificationController.markNotificationAsRead);
router.put('/:recipientId/read-all', notificationController.markAllAsRead);
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;
