const notificationService = require('../service/notification.service');

const createNotification = async (req, res) => {
  try {
    const { recipientId, recipientType, type, title, content, claimId } = req.body;
    const notification = await notificationService.createAndEmit({
      recipientId, recipientType, type, title, content, claimId,
    });
    res.status(201).json(notification);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getNotifications = async (req, res) => {
  try {
    const notifications = await notificationService.getNotifications(req.params.recipientId);
    res.status(200).json(notifications);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching notifications' });
  }
};

const markNotificationAsRead = async (req, res) => {
  try {
    const notification = await notificationService.markAsRead(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Notification not found' });
    res.status(200).json(notification);
  } catch (error) {
    res.status(500).json({ message: 'Error marking notification as read' });
  }
};

const markAllAsRead = async (req, res) => {
  try {
    await notificationService.markAllAsRead(req.params.recipientId);
    res.status(200).json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: 'Error marking notifications as read' });
  }
};

const deleteNotification = async (req, res) => {
  try {
    const Notification = require('../models/notification.model');
    await Notification.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting notification' });
  }
};

module.exports = {
  createNotification,
  getNotifications,
  markNotificationAsRead,
  markAllAsRead,
  deleteNotification,
};
