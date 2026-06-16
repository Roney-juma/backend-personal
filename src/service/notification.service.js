const Notification = require('../models/notification.model');
const { getIO } = require('../socket');
const firebaseService = require('./firebase.service');

const createAndEmit = async ({ recipientId, recipientType, type, title, content, claimId }) => {
  const notification = await Notification.create({
    recipientId,
    recipientType,
    type,
    title,
    content,
    ...(claimId && { claimId }),
  });

  // Socket.IO — real-time if user is connected to the portal
  try {
    getIO().to(`notification:${recipientId}`).emit('notification', notification);
  } catch {
    // Socket not yet initialized or recipient not connected
  }

  // Firebase Cloud Messaging — push to mobile/web app
  await firebaseService.sendPushNotification({
    recipientId,
    recipientType,
    title,
    body: content,
    data: { notificationId: String(notification._id), ...(claimId && { claimId: String(claimId) }) },
  });

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
