const mongoose = require('mongoose');
const { Schema } = mongoose;

const notificationSchema = new Schema({
  recipientId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  recipientType: {
    type: String,
    enum: ['assessor', 'garage', 'supplier', 'customer', 'admin', 'investigator'],
    required: true,
  },
  type: {
    type: String,
    enum: [
      'claim_submitted', 'claim_approved', 'claim_rejected',
      'bid_awarded', 'bid_rejected', 'repair_started', 'claim_completed',
      'self_repair_opted', 'self_repair_submitted', 'self_repair_approved',
      'self_repair_rejected', 'self_repair_paid',
      'account_deletion_requested',
      'investigation_assigned', 'investigation_submitted', 'investigation_completed',
    ],
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  claimId: {
    type: Schema.Types.ObjectId,
    ref: 'Claim',
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Notification = mongoose.model('Notification', notificationSchema);
module.exports = Notification;
