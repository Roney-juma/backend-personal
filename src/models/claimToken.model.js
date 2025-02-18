const mongoose = require('mongoose');

const { Schema } = mongoose;

const claimTokenSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  token: { type: String, required: true, unique: true },
  used: { type: Boolean, default: false },
}, { timestamps: true });

const ClaimToken = mongoose.model('ClaimToken', claimTokenSchema);


module.exports = ClaimToken;
