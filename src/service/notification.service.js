const Notification = require('../models/notification.model');
const { getIO } = require('../socket');

const createAndEmit = async ({ recipientId, recipientType, type, title, content, claimId }) => {
  const notification = await Notification.create({
    recipientId,
    recipientType,
    type,
    title,
    content,
    ...(claimId && { claimId }),
  });

  try {
    getIO().to(`notification:${recipientId}`).emit('notification', notification);
  } catch {
    // Socket not yet initialized or recipient not connected — DB record is sufficient
  }

  return notification;
};

const getNotifications = async (recipientId) => {
  return Notification.find({ recipientId }).sort({ createdAt: -1 }).limit(50);
};

const markAsRead = async (notificationId) => {
  return Notification.findByIdAndUpdate(notificationId, { isRead: true }, { new: true });
};

const markAllAsRead = async (recipientId) => {
  return Notification.updateMany({ recipientId, isRead: false }, { isRead: true });
};

module.exports = { createAndEmit, getNotifications, markAsRead, markAllAsRead };
