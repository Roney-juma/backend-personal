require('../config/firebase');
const { getMessaging } = require('firebase-admin/messaging');
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

const sendPushNotification = async ({ recipientId, recipientType, title, body, data = {} }) => {
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
    // Log but never throw — FCM failure must not break the main flow
    console.error('FCM send error:', err?.errorInfo?.message ?? err.message);
  }
};

const updateFcmToken = async (recipientId, recipientType, fcmToken) => {
  const Model = MODEL_MAP[recipientType];
  if (!Model) throw new Error('Unknown recipient type');
  return Model.findByIdAndUpdate(recipientId, { fcmToken }, { new: true });
};

module.exports = { sendPushNotification, updateFcmToken };
