const bcrypt = require('bcrypt');
const User = require('../models/users.model');
const emailService = require('./email.service');

const createUser = async (userData) => {
    const { username, password, fullName, email, role, phone, department, position } = userData;

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
        throw new Error('User with this email or username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

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

    const savedUser = await newUser.save();

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
    return User.find().populate('role').exec();
};

const getUserById = async (userId) => {
    return User.findById(userId).populate('role').exec();
};

const updateUser = async (userId, updateData) => {
    return User.findByIdAndUpdate(userId, updateData, { new: true });
};

const deleteUser = async (userId) => {
    return User.findByIdAndDelete(userId);
};

const resetPassword = async (email, newPassword) => {
    const user = await User.findOne({ email });
    if (!user) throw new Error('User not found');

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { message: 'Password has been reset successfully' };
};

const loginUserWithEmailAndPassword = async (email, password) => {
    const user = await User.findOne({ email });

    if (!user) return false;

    const authorized = await bcrypt.compare(password, user.password);
    if (!authorized) return false;

    return user;
};

module.exports = {
    createUser,
    getAllUsers,
    getUserById,
    updateUser,
    deleteUser,
    resetPassword,
    loginUserWithEmailAndPassword,
};
