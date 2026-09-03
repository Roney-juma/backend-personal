const bcrypt = require('bcrypt');
const ProviderUser = require('../models/providerUser.model');
const emailService = require('./email.service');
const { isLocked, lockMinutesRemaining, registerFailedAttempt, resetAttempts } = require('../utils/accountLockout');
const { DEFAULT_TEMP_PASSWORD } = require('../constants/userDefaults');
const { createResetToken, verifyResetToken, resetEmailBody } = require('../utils/passwordReset');
const { assertValidPassword } = require('../utils/passwordPolicy');

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
    const { username, password, fullName, email, phone, department, position, role, profilePictureUrl } = data;

    const existing = await ProviderUser.findOne({ $or: [{ username }, { email }] });
    if (existing) {
        throw new Error('A provider user with this email or username already exists');
    }

    // Admin-created accounts use a default temporary password and must change it on first login.
    const hashedPassword = await bcrypt.hash(password || DEFAULT_TEMP_PASSWORD, 10);

    const newUser = new ProviderUser({
        username,
        password: hashedPassword,
        fullName,
        email,
        // Captured at creation rather than left to each person's profile page:
        // workspace notifications mirror to WhatsApp by looking the number up
        // from the address, so an account without one is email-only until
        // somebody remembers to fill it in.
        phone: phone ? String(phone).trim() : undefined,
        department: department || undefined,
        position: position || undefined,
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
            `Dear ${saved.fullName},\n\nYour provider portal account has been created.\n\nEmail: ${saved.email}\nTemporary password: ${DEFAULT_TEMP_PASSWORD}\n\nFor your security, you will be asked to set a new password the first time you log in.\n\nBest Regards,\nAVE Platform Team`
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

/** Administrator-initiated reset: an authenticated admin sets someone's password. */
const resetPassword = async (email, newPassword) => {
    const user = await ProviderUser.findOne({ email });
    if (!user) throw new Error('Provider user not found');

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { message: 'Password reset successfully' };
};

/**
 * Self-service step one: email a single-use code to the address given.
 *
 * Until this existed, a member of staff who forgot their password had to find an
 * admin who still had theirs — which is exactly the person nobody can reach at
 * seven in the morning.
 *
 * The response is identical whether or not the account exists, so the endpoint
 * cannot be used to discover who works here.
 */
const forgotPassword = async (email) => {
    const e = String(email || '').trim().toLowerCase();
    const user = e ? await ProviderUser.findOne({ email: e }) : null;

    // A deactivated account must not be recoverable by its former holder.
    if (user && user.active) {
        const { rawToken, hashedToken, expires } = await createResetToken();
        // updateOne, not save(): assigning to the document would re-hash the
        // already-hashed password field on the way out.
        await ProviderUser.updateOne(
            { _id: user._id },
            { $set: { resetPasswordToken: hashedToken, resetPasswordExpires: expires } }
        );

        await emailService.sendEmailNotification(
            user.email,
            'Your AVE Provider Portal password reset code',
            resetEmailBody(user.fullName, rawToken)
        ).catch(() => { /* non-fatal — never reveal delivery failure to the caller */ });
    }

    return { message: 'If an account exists for that email, a reset code has been sent.' };
};

/** Self-service step two: exchange the emailed code for a new password. */
const resetPasswordWithToken = async (email, token, newPassword) => {
    const e = String(email || '').trim().toLowerCase();
    const user = e ? await ProviderUser.findOne({ email: e }) : null;
    if (!user || !user.active || !(await verifyResetToken(token, user))) {
        throw new Error('Reset code is invalid or has expired');
    }

    assertValidPassword(newPassword);
    const hashed = await bcrypt.hash(newPassword, 10);
    await ProviderUser.updateOne(
        { _id: user._id },
        {
            // Clear mustChangePassword too: the person has just chosen this one,
            // so bouncing them into the change-password screen makes no sense.
            $set: { password: hashed, mustChangePassword: false, failedLoginAttempts: 0 },
            $unset: { resetPasswordToken: '', resetPasswordExpires: '', lockUntil: '' },
        }
    );

    return { message: 'Password has been reset successfully' };
};

module.exports = {
    login,
    createProviderUser,
    getAllProviderUsers,
    getProviderUserById,
    updateProviderUser,
    deactivateProviderUser,
    resetPassword,
    forgotPassword,
    resetPasswordWithToken,
};
