const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true },
  collectionName: { type: String, required: true }, // Name of the collection/table being modified
  documentId: { type: mongoose.Schema.Types.ObjectId, required: true }, // ID of the document being modified
  changes: { type: mongoose.Schema.Types.Mixed }, // Details of the changes (e.g., old and new values)
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // ID of the user performing the action
  timestamp: { type: Date, default: Date.now },
});

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;