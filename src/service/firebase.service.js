require('../config/firebase');
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('../middlewheres/logger');
const { getQueue } = require('../queue/queues');
const Customer = require('../models/customerModel');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');

const MODEL_MAP = {
  customer: Customer,
  assessor: Assessor,
  garage: Garage,
  supplier: Supplier,
};

// Direct send — called by the worker (and as fallback when Redis is unavailable).
// Does an fcmToken lookup + a live FCM HTTP call, so it must never run on the request path.
const sendPushDirect = async ({ recipientId, recipientType, title, body, data = {} }) => {
  try {
    const Model = MODEL_MAP[recipientType];
    if (!Model) return;

    const user = await Model.findById(recipientId).select('fcmToken').lean();
    if (!user?.fcmToken) return;

    await getMessaging().send({
      token: user.fcmToken,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
    });
  } catch (err) {
    logger.error('FCM send error: %s', err?.errorInfo?.message ?? err.message);
  }
};

// Enqueued send — offloads the FCM HTTP call to the worker; falls back to direct if Redis is down.
const sendPushNotification = async ({ recipientId, recipientType, title, body, data = {} }) => {
  const queue = getQueue();
  if (queue) {
    try {
      await queue.add('push', { recipientId, recipientType, title, body, data });
      return;
    } catch (err) {
      logger.warn(`Push queue failed, falling back to direct send | ${err.message}`);
    }
  }
  await sendPushDirect({ recipientId, recipientType, title, body, data });
};

const updateFcmToken = async (recipientId, recipientType, fcmToken) => {
  const Model = MODEL_MAP[recipientType];
  if (!Model) throw new Error('Unknown recipient type');
  return Model.findByIdAndUpdate(recipientId, { fcmToken }, { new: true });
};

module.exports = { sendPushNotification, sendPushDirect, updateFcmToken };
