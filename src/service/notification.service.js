const Notification = require('../models/notification.model');
const { getIO } = require('../socket');
const firebaseService = require('./firebase.service');
const whatsappService = require('./whatsapp.service');

// Lazy model imports — avoids circular dependency issues
const getRecipientModel = (recipientType) => {
  switch (recipientType) {
    case 'customer':   return require('../models/customerModel');
    case 'assessor':   return require('../models/assessor.model');
    case 'garage':     return require('../models/garage.model');
    case 'supplier':   return require('../models/supplier.model');
    case 'investigator': return require('../models/investigator.model');
    default:           return null;
  }
};

// Resolve recipient's WhatsApp number from DB when not provided inline
const resolveWhatsAppNumber = async (recipientId, recipientType, inlineNumber) => {
  if (inlineNumber) return inlineNumber;
  const Model = getRecipientModel(recipientType);
  if (!Model) return null;
  const doc = await Model.findById(recipientId).select('whatsappNumber').lean();
  return doc?.whatsappNumber || null;
};

const createAndEmit = async ({
  recipientId,
  recipientType,
  type,
  title,
  content,
  claimId,
  whatsappNumber,  // optional — pass directly when already known, otherwise resolved from DB
}) => {
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

  // WhatsApp — send a concise version of the notification
  const waNumber = await resolveWhatsAppNumber(recipientId, recipientType, whatsappNumber);
  if (waNumber) {
    await whatsappService.sendWhatsAppMessage(
      waNumber,
      `*${title}*\n${content}`
    );
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
