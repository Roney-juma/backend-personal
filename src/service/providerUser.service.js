const bcrypt = require('bcrypt');
const ProviderUser = require('../models/providerUser.model');
const emailService = require('./email.service');
const { isLocked, lockMinutesRemaining, registerFailedAttempt, resetAttempts } = require('../utils/accountLockout');

const login = async (email, password) => {
    const user = await ProviderUser.findOne({ email }).populate('role');

    if (!user) {
        return { error: 'Invalid credentials' };
    }

    if (!user.active) {
        return { error: 'Account is deactivated' };
    }

    if (isLocked(user)) {
        return { error: `Account temporarily locked due to too many failed attempts. Try again in ${lockMinutesRemaining(user)} minute(s).` };
    }

    const authorized = await bcrypt.compare(password, user.password);
    if (!authorized) {
        await registerFailedAttempt(user);
        return { error: 'Invalid credentials' };
    }

    await resetAttempts(user);
    user.lastLogin = new Date();
    await user.save();

    return { user };
};

const createProviderUser = async (data) => {
    const { username, password, fullName, email, role, profilePictureUrl } = data;

    const existing = await ProviderUser.findOne({ $or: [{ username }, { email }] });
    if (existing) {
        throw new Error('A provider user with this email or username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new ProviderUser({
        username,
        password: hashedPassword,
        fullName,
        email,
        role: role || undefined,
        profilePictureUrl: profilePictureUrl || undefined,
        // Admin sets the initial password, so require a change on first login.
        mustChangePassword: true,
    });

    const saved = await newUser.save();

    if (saved.email) {
        await emailService.sendEmailNotification(
            saved.email,
            'Welcome to AVE Provider Portal — Your Account Details',
            `Dear ${saved.fullName},\n\nYour provider portal account has been created.\n\nUsername: ${saved.username}\nEmail: ${saved.email}\n\nPlease use your registered email and password to log in.\n\nBest Regards,\nAVE Platform Team`
        ).catch(() => { /* non-fatal */ });
    }

    return saved;
};

const getAllProviderUsers = async () => {
    return ProviderUser.find().populate('role').exec();
};

const getProviderUserById = async (id) => {
    return ProviderUser.findById(id).populate('role').exec();
};

const updateProviderUser = async (id, data) => {
    const { password, ...safeData } = data;
    return ProviderUser.findByIdAndUpdate(id, safeData, { new: true }).populate('role');
};

const deactivateProviderUser = async (id) => {
    return ProviderUser.findByIdAndUpdate(id, { active: false }, { new: true });
};

const resetPassword = async (email, newPassword) => {
    const user = await ProviderUser.findOne({ email });
    if (!user) throw new Error('Provider user not found');

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { message: 'Password reset successfully' };
};

module.exports = {
    login,
    createProviderUser,
    getAllProviderUsers,
    getProviderUserById,
    updateProviderUser,
    deactivateProviderUser,
    resetPassword,
};
