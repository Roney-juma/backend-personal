const mongoose = require('mongoose');

const ticketMessageSchema = new mongoose.Schema(
  {
    sender: { type: String, enum: ['company', 'support'], required: true },
    senderName: { type: String },
    message: { type: String, required: true },
    attachments: [{ type: String }],
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: String, unique: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'resolved', 'closed'],
      default: 'open',
    },
    category: {
      type: String,
      enum: ['technical', 'account', 'general','bug', 'feature_request','perfomance','data issue', 'other'],
      default: 'general',
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'providerUser' },
    messages: [ticketMessageSchema],
    resolvedAt: { type: Date },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

supportTicketSchema.pre('save', async function (next) {
  if (!this.ticketNumber) {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await mongoose.model('SupportTicket').countDocuments();
    this.ticketNumber = `TKT-${yyyymm}-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
