const bcrypt = require('bcrypt');
const User = require('../models/users.model');
const emailService = require('./email.service');

const createUser = async (userData) => {
    const { company,username, password, fullName, email, role, phone, department, position } = userData;

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
        throw new Error('User with this email or username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
        company,
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
- Password: password (the one you set during registration)
Please use your registered email and password to log in.
If you have any questions, feel free to contact us.
Best Regards,
Admin Team`
        );
    }

    return savedUser;
};

const getAllUsers = async () => {
    // Populate the role field to get role details along with company information
    return User.find().populate('role').populate('company').exec();
};

const getUserById = async (userId) => {
    return User.findById(userId).populate('role').populate('company').exec();
};

// Get users by company ID with pagination
const getUsersByCompanyId = async (companyId, { page = 1, limit = 10, search = '' } = {}) => {
    const query = { company: companyId };
    if (search) {
        query.$or = [
            { fullName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { username: { $regex: search, $options: 'i' } },
        ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
        User.find(query).select('-password').skip(skip).limit(Number(limit)).exec(),
        User.countDocuments(query),
    ]);
    return { users, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) };
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
    getUsersByCompanyId
};
