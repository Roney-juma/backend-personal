const bcrypt = require('bcrypt');
const User = require('../models/users.model');
const Garage = require('../models/garage.model');
const Assessor = require('../models/assessor.model.js');
const customerModel = require("../models/customerModel");
const emailService = require('./email.service');

const createUser = async (userData) => {
    const { username, password, fullName, email, role, phone, department, position } = userData;

    // Check if the user with the same email or username already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
        throw new Error('User with this email or username already exists');
    }

    // Hash the password before saving the user
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new user with the provided details
    const newUser = new User({
        username,
        password: hashedPassword,
        fullName,
        email,
        role,
        phone,
        department,
        position
    });

    // Save the new user
    const savedUser = await newUser.save();

    // Send email notification with account details
    if (savedUser && savedUser.email) {
        await emailService.sendEmailNotification(
            savedUser.email,
            'Welcome to Ave Insurance - Your Account Details',
            `Dear ${savedUser.fullName},
Welcome to Ave Insurance! Your account has been successfully created.
Here are your account details:
- Username: ${savedUser.username}
- Email: ${savedUser.email}
Please use your registered email and password to log in.
If you have any questions, feel free to contact us.
Best Regards,
Admin Team`
        );
    }

    return savedUser;
};

const getAllUsers = async () => {
    const users = await User.find()
    .populate('role', 'name')
    .exec();
    return users;
};

const getUserById = async (userId) => {
    return await User.findById(userId);
};

const updateUser = async (userId, updateData) => {
    return await User.findByIdAndUpdate(userId, updateData, { new: true });
};

const deleteUser = async (userId) => {
    return await User.findByIdAndDelete(userId);
};

const resetPassword = async (email, newPassword) => {
    const user = await User.findOne({ email });
    if (!user) {
        throw new Error('User not found');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    return { message: 'Password has been reset successfully' };
};
const loginUserWithEmailAndPassword = async (email, password) => {
    const user = await User.findOne({ email });

    if (!user) {
        console.log("User not found");
        return false;
    }

    const authorized = await bcrypt.compare(password, user.password);
    
    if (!authorized) {
        return false; 
    }

    return user;
};


module.exports = {
    createUser,
    getAllUsers,
    getUserById,
    updateUser,
    deleteUser,
    resetPassword,
    loginUserWithEmailAndPassword
};
