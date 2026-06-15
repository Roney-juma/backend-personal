const mongoose = require('mongoose');

const demoRequestSchema = new mongoose.Schema(
  {
    fullName:    { type: String, required: true, trim: true },
    phoneNumber: { type: String, required: true, trim: true },
    email:       { type: String, required: true, trim: true, lowercase: true },
    company:     { type: String, trim: true },
    message:     { type: String, trim: true },
    status: {
      type: String,
      enum: ['new', 'contacted', 'converted', 'rejected'],
      default: 'new',
    },
    notes:      { type: String },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'providerUser' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DemoRequest', demoRequestSchema);
