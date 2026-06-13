const mongoose = require('mongoose');

const companyActivitySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', required: true },
    action: { type: String, required: true },
    module: { type: String, required: true },
    description: { type: String },
    performedBy: { type: String },
    ipAddress: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanyActivity', companyActivitySchema);
