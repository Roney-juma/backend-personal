const mongoose = require('mongoose');
const { Schema } = mongoose;

const claimPhotoHashSchema = new Schema({
  claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
  url: { type: String, required: true },
  phash: { type: String, required: true }, // 64-char hex perceptual hash
}, { timestamps: true });

claimPhotoHashSchema.index({ phash: 1 });
claimPhotoHashSchema.index({ claimId: 1 });

module.exports = mongoose.model('ClaimPhotoHash', claimPhotoHashSchema);
