const express = require('express');
const notificationController = require('../controllers/notification.controller');
const verifyToken = require('../middlewheres/verifyToken');
const Notification = require('../models/notification.model');

const router = express.Router();

// Notifications are strictly per-recipient. Every route requires a valid JWT
// and a caller may only touch THEIR OWN notifications (platform staff
// excepted) — ids/recipient ids in the URL are never trusted on their own.
const isStaff = (req) => req.user?.accountType === 'ProviderUser';

const ownRecipientOnly = (param) => (req, res, next) => {
  if (isStaff(req)) return next();
  if (String(req.params[param]) !== String(req.user?.id)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

// For routes addressed by notification id: load it and require ownership.
const ownNotificationOnly = async (req, res, next) => {
  try {
    const notification = await Notification.findById(req.params.id).select('recipientId');
    if (!notification) return res.status(404).json({ message: 'Notification not found' });
    if (!isStaff(req) && String(notification.recipientId) !== String(req.user?.id)) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: 'Error verifying notification' });
  }
};

// Creating notifications is an internal/system concern — platform staff only.
router.post('/', verifyToken(), (req, res, next) => {
  if (!isStaff(req)) return res.status(403).json({ message: 'Forbidden' });
  next();
}, notificationController.createNotification);

router.get('/:recipientId', verifyToken(), ownRecipientOnly('recipientId'), notificationController.getNotifications);
router.put('/:id/read', verifyToken(), ownNotificationOnly, notificationController.markNotificationAsRead);
router.put('/:recipientId/read-all', verifyToken(), ownRecipientOnly('recipientId'), notificationController.markAllAsRead);
router.delete('/:id', verifyToken(), ownNotificationOnly, notificationController.deleteNotification);

module.exports = router;
