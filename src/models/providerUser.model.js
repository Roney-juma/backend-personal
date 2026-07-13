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
        failedLoginAttempts: { type: Number, default: 0 },
        lockUntil: { type: Date },
        mfaEnabled: { type: Boolean, default: false },
        mfaSecret: { type: String },
        mustChangePassword: { type: Boolean, default: false },
        profilePictureUrl: { type: String },
    },
    { timestamps: true }
);

const ProviderUser = mongoose.model('ProviderUser', providerUserSchema);
module.exports = ProviderUser;
