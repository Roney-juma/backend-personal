const mongoose = require('mongoose');

const providerUserSchema = new mongoose.Schema(
    {
        username: { type: String, required: true, unique: true, trim: true },
        password: { type: String, required: true },
        fullName: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        /**
         * Used to mirror workspace notifications to WhatsApp — see
         * utils/resolveRecipient. Without a number on file, a staff member gets
         * meeting invitations and task assignments by email only.
         *
         * This and the two profile fields below were already accepted by
         * updateMe, but were absent from the schema, so Mongoose silently
         * discarded them: saving a phone number appeared to work and changed
         * nothing.
         */
        phone: { type: String, trim: true },
        department: { type: String, trim: true },
        position: { type: String, trim: true },
        role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
        active: { type: Boolean, default: true },
        lastLogin: { type: Date },
        failedLoginAttempts: { type: Number, default: 0 },
        lockUntil: { type: Date },
        mfaEnabled: { type: Boolean, default: false },
        mfaSecret: { type: String },
        mustChangePassword: { type: Boolean, default: false },
        profilePictureUrl: { type: String },
        // Self-service password reset. Only the bcrypt hash of the code is
        // stored, so a database read cannot be used to take over an account.
        resetPasswordToken: { type: String },
        resetPasswordExpires: { type: Date },
    },
    { timestamps: true }
);

const ProviderUser = mongoose.model('ProviderUser', providerUserSchema);
module.exports = ProviderUser;
