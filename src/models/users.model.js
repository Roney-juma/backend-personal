const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const bcrypt = require('bcryptjs');

const usersSchema = new mongoose.Schema({
    username: { 
        type: String, 
        required: true, 
        unique: true },
    password: { 
        type: String, 
        required: true },
    fullName: { 
        type: String,
        required: true },
    email: { 
        type: String, 
        required: true, 
        unique: true },
    role: {
        type: String,
        enum: ['admin', 'manager', 'staff'],
        default: 'staff'
    },
    phone: { 
        type: String },
    department: { 
        type: String },
    position: { 
        type: String },
    active: { 
        type: Boolean, 
        default: true },
    lastLogin: { 
        type: Date },
    profilePictureUrl: { 
        type: String },
    createdAt: { 
        type: String, 
        default: 'Admin' },
    createdAt: { 
        type: Date, 
        default: Date.now },
    updatedAt: { 
        type: Date, 
        default: Date.now }
})

const Users = mongoose.model('Users', usersSchema)

module.exports = Users