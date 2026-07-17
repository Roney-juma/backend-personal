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
        type: String, 
        required: true 
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
    profilePictureUrl: { type: String }
}, { timestamps: true });

usersSchema.plugin(softDelete);

const Users = mongoose.model('Users', usersSchema);
module.exports = Users;
