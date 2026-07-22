const bcrypt = require('bcrypt');
const User = require('../models/users.model');
const emailService = require('./email.service');
const { isLocked, registerFailedAttempt, resetAttempts, AccountLockedError } = require('../utils/accountLockout');
const { DEFAULT_TEMP_PASSWORD } = require('../constants/userDefaults');

const createUser = async (userData) => {
    const { company,username, password, fullName, email, role, phone, department, position } = userData;

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
        throw new Error('User with this email or username already exists');
    }

    // Admin-created accounts use a default temporary password and must change it on
    // first login. When a caller provides an explicit password (e.g. the company
    // contact person set up during onboarding), use it so the emailed credential matches.
    const tempPassword = password || DEFAULT_TEMP_PASSWORD;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const newUser = new User({
        company,
        username,
        password: hashedPassword,
        fullName,
        email,
        role,
        phone,
        department,
        position,
        // Admin sets the initial password, so require a change on first login.
        mustChangePassword: true,
    });

    const savedUser = await newUser.save();

    if (savedUser && savedUser.email) {
        await emailService.sendEmailNotification(
            savedUser.email,
            'Welcome to Ave Insurance - Your Account Details',
            `Dear ${savedUser.fullName},
Welcome to Ave Insurance! Your account has been successfully created.
Here are your login details:
- Email: ${savedUser.email}
- Temporary password: ${tempPassword}
For your security, you will be asked to set a new password the first time you log in.
If you have any questions, feel free to contact us.
Best Regards,
Admin Team`
        );
    }

    return savedUser;
};

const getAllUsers = async ({ page = 1, limit = 10, search = '' } = {}) => {
    const query = {};
    if (search) {
        query.$or = [
            { fullName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
        ];
    }

    const p = Math.max(Number(page) || 1, 1);
    const l = Math.min(Math.max(Number(limit) || 10, 1), 100); // cap page size
    const skip = (p - 1) * l;

    const [users, total] = await Promise.all([
        User.find(query)
            .select('-password -mfaSecret') // .lean() bypasses the model's toJSON transform
            .populate('role')
            .populate('company')
            .skip(skip)
            .limit(l)
            .sort({ createdAt: -1 })
            .lean(),
        User.countDocuments(query),
    ]);

    return { users, total, page: p, limit: l, pages: Math.ceil(total / l) };
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
        User.find(query).select('-password').populate('role').skip(skip).limit(Number(limit)).exec(),
        User.countDocuments(query),
    ]);
    return { users, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) };
};

const updateUser = async (userId, updateData, company) => {
    // Scope to the requester's company (staff → no scope). Strip company from the
    // payload so a company user can't move a user to another tenant.
    const filter = { _id: userId, ...(company ? { company } : {}) };
    if (company) delete updateData.company;
    return User.findOneAndUpdate(filter, updateData, { new: true });
};

const deleteUser = async (userId, company) => {
    const filter = { _id: userId, ...(company ? { company } : {}) };
    return User.softDeleteOne(filter);
};

const resetPassword = async (email, newPassword, company) => {
    // Scope by the requester's company so an insurer admin can't reset a user
    // belonging to another tenant (platform staff pass no company → global).
    const user = await User.findOne({ email, ...(company ? { company } : {}) });
    if (!user) throw new Error('User not found');

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { message: 'Password has been reset successfully' };
};

const loginUserWithEmailAndPassword = async (email, password) => {
    const user = await User.findOne({ email });

    if (!user) return false;

    if (isLocked(user)) {
        throw new AccountLockedError(user);
    }

    const authorized = await bcrypt.compare(password, user.password);
    if (!authorized) {
        await registerFailedAttempt(user);
        return false;
    }

    await resetAttempts(user);

    // Tenant lifecycle: users of a suspended/pending/soft-deleted company must
    // not log in. (softDelete query middleware hides deleted companies from
    // populate, so a live user with an unresolvable company is also blocked.)
    if (user.company) {
        await user.populate('company', 'status');
        if (!user.company || user.company.status !== 'active') {
            throw new Error('Your company account is not active. Please contact support.');
        }
    }

    // The portal derives nav/permissions from role.name and role.permissions,
    // so the login response must carry the full role, not just its id.
    await user.populate('role');
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
