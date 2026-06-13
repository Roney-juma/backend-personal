const mongoose = require('mongoose');

const providerUserSchema = new mongoose.Schema(
    {
        username: { type: String, required: true, unique: true, trim: true },
        password: { type: String, required: true },
        fullName: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
        active: { type: Boolean, default: true },
        lastLogin: { type: Date },
        profilePictureUrl: { type: String },
    },
    { timestamps: true }
);

const ProviderUser = mongoose.model('ProviderUser', providerUserSchema);
module.exports = ProviderUser;
