const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const bcrypt = require('bcryptjs');

const usersSchema = new mongoose.Schema({
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany' },
    username: { 
        type: String, 
        required: true, 
        unique: true 
    },
    password: {
        // Not required for SSO (Entra) accounts, which have no local password.
        type: String,
        required: function () { return this.authProvider !== 'entra'; },
    },
    fullName: { 
        type: String,
        required: true 
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    // Optional, and only used for outbound notification. Added with the Legal
    // module: legal reminders (time-bars, court dates, escalations) go to staff,
    // and WhatsApp is the channel people actually read. Without a number the
    // mirror silently skips them and they still get email and in-app — so this
    // is additive and no existing account breaks by lacking it.
    phone: { type: String, trim: true },
    role: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Role'
    },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String },
    mustChangePassword: { type: Boolean, default: false },
    // Identity provider: 'local' (email+password) or 'entra' (Microsoft Entra SSO).
    authProvider: { type: String, enum: ['local', 'entra'], default: 'local' },
    ssoObjectId: { type: String },   // Entra object id (oid) — stable per-user identifier
    ssoTenantId: { type: String },   // Entra tenant id (tid)
    profilePictureUrl: { type: String }
}, { timestamps: true });

usersSchema.plugin(softDelete);

// Credential material must never leave the API when a user document is
// serialized (login/MFA/SSO responses, user lists). Queries using .lean()
// bypass this transform and must exclude these fields with .select().
usersSchema.set('toJSON', {
    transform: (_doc, ret) => {
        delete ret.password;
        delete ret.mfaSecret;
        delete ret.failedLoginAttempts;
        delete ret.lockUntil;
        return ret;
    },
});

const Users = mongoose.model('Users', usersSchema);
module.exports = Users;
