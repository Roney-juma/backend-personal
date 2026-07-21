const tokenService = require('../service/token.service');
const userService = require('../service/users.service');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');

const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await userService.loginUserWithEmailAndPassword(email, password);
        if (!user) {
            await writeAuditLog(req, {
                action: 'LOGIN',
                module: 'Auth',
                actionDescription: `Failed login attempt for ${email}`,
                resourceType: 'User',
                statusCode: 401,
                success: false,
            });
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        // Attribute the audit entry to the just-authenticated user — the login
        // request itself carries no token, so req.user is otherwise empty.
        req.user = user;
        // If MFA is enabled, do not issue access tokens yet — return a short-lived
        // challenge token; the client must complete /users/mfa/verify-login.
        if (user.mfaEnabled) {
            const mfaToken = tokenService.generateMfaChallengeToken(user._id, 'User');
            await writeAuditLog(req, {
                action: 'LOGIN',
                module: 'Auth',
                actionDescription: `${user.fullName} (${user.email}) passed password check — MFA challenge issued`,
                resourceType: 'User',
                resourceId: user._id,
                statusCode: 200,
                success: true,
            });
            return res.status(200).json({ mfaRequired: true, mfaToken });
        }
        const tokens = tokenService.generateCompanyUserToken(user);
        await writeAuditLog(req, {
            action: 'LOGIN',
            module: 'Auth',
            actionDescription: `${user.fullName} (${user.email}) logged in`,
            resourceType: 'User',
            resourceId: user._id,
            statusCode: 200,
            success: true,
        });
        res.status(200).json({ user, tokens });
    } catch (error) {
        if (error.code === 'ACCOUNT_LOCKED') {
            return res.status(429).json({ message: error.message });
        }
        res.status(500).json({ message: 'Login failed', error: error.message });
    }
};

const createUser = async (req, res) => {
    try {
        const payload = { ...req.body };
        // Tenant scoping: a company user may only create users within their own
        // company, regardless of what the client sends.
        const requesterCompany = await getRequesterCompany(req);
        if (requesterCompany) payload.company = requesterCompany;
        const savedUser = await userService.createUser(payload);
        await writeAuditLog(req, {
            action: 'CREATE',
            module: 'User',
            actionDescription: `Created user ${savedUser.fullName} (${savedUser.email})`,
            resourceType: 'User',
            resourceId: savedUser._id,
            statusCode: 201,
            success: true,
            changes: { old: null, new: { fullName: savedUser.fullName, email: savedUser.email, role: savedUser.role } },
        });
        res.status(201).json(savedUser);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAllUsers = async (req, res) => {
    try {
        const { page, limit, search } = req.query;
        // A company user only sees their own company's users; platform staff see all.
        const requesterCompany = await getRequesterCompany(req);
        const users = requesterCompany
            ? await userService.getUsersByCompanyId(requesterCompany, { page, limit, search })
            : await userService.getAllUsers({ page, limit, search });
        res.status(200).json(users);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAdminUser = async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        // A company user may only view their own company's users.
        const company = await getRequesterCompany(req);
        if (!belongsToCompany(user.company, company)) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
// Get comany Users
const getCompanyUsers = async (req, res) => {
    try {
        // A company user may only list their own company, whatever id is in the
        // URL; platform staff may pass any company id.
        const requesterCompany = await getRequesterCompany(req);
        const companyId = requesterCompany ? String(requesterCompany) : req.params.id;
        const users = await userService.getUsersByCompanyId(companyId);
        res.status(200).json(users);
    }
    catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const updateAdminUser = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const updatedUser = await userService.updateUser(req.params.id, req.body, company);
        if (!updatedUser) return res.status(404).json({ message: 'User not found' });
        await writeAuditLog(req, {
            action: 'UPDATE',
            module: 'User',
            actionDescription: `Updated user ${updatedUser.fullName} (${updatedUser.email})`,
            resourceType: 'User',
            resourceId: updatedUser._id,
            statusCode: 200,
            success: true,
        });
        res.status(200).json(updatedUser);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const deleteAdminUser = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const deletedUser = await userService.deleteUser(req.params.id, company);
        if (!deletedUser) return res.status(404).json({ message: 'User not found' });
        await writeAuditLog(req, {
            action: 'DELETE',
            module: 'User',
            actionDescription: `Deleted user ${deletedUser.fullName} (${deletedUser.email})`,
            resourceType: 'User',
            resourceId: deletedUser._id,
            statusCode: 200,
            success: true,
        });
        res.status(200).json({ message: 'User deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        const company = await getRequesterCompany(req);
        const response = await userService.resetPassword(email, newPassword, company);
        // Note: no `changes` here — the request body holds the new password and the
        // helper's sanitized requestBody snapshot is all the context needed.
        await writeAuditLog(req, {
            action: 'RESET_PASSWORD',
            module: 'Auth',
            actionDescription: `Reset password for ${email}`,
            resourceType: 'User',
            statusCode: 200,
            success: true,
        });
        res.status(200).json(response);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

module.exports = {
    login,
    createUser,
    getAllUsers,
    getAdminUser,
    updateAdminUser,
    deleteAdminUser,
    resetPassword,
    getCompanyUsers
};
