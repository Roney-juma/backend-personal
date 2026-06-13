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
    profilePictureUrl: { type: String }
}, { timestamps: true });

const Users = mongoose.model('Users', usersSchema);
module.exports = Users;
