const mongoose = require('mongoose');
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

const Users = mongoose.model('Users', usersSchema);
module.exports = Users;
