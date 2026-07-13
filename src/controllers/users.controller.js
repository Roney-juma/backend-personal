const tokenService = require('../service/token.service');
const userService = require('../service/users.service');

const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await userService.loginUserWithEmailAndPassword(email, password);
        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        // If MFA is enabled, do not issue access tokens yet — return a short-lived
        // challenge token; the client must complete /users/mfa/verify-login.
        if (user.mfaEnabled) {
            const mfaToken = tokenService.generateMfaChallengeToken(user._id, 'User');
            return res.status(200).json({ mfaRequired: true, mfaToken });
        }
        const tokens = tokenService.generateProviderUserToken(user);
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
        const savedUser = await userService.createUser(req.body);
        res.status(201).json(savedUser);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAllUsers = async (req, res) => {
    try {
        const { page, limit, search } = req.query;
        const users = await userService.getAllUsers({ page, limit, search });
        res.status(200).json(users);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAdminUser = async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
// Get comany Users
const getCompanyUsers = async (req, res) => {
    try {
        const users = await userService.getUsersByCompanyId(req.params.id);
        res.status(200).json(users);
    }
    catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const updateAdminUser = async (req, res) => {
    try {
        const updatedUser = await userService.updateUser(req.params.id, req.body);
        if (!updatedUser) return res.status(404).json({ message: 'User not found' });
        res.status(200).json(updatedUser);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const deleteAdminUser = async (req, res) => {
    try {
        const deletedUser = await userService.deleteUser(req.params.id);
        if (!deletedUser) return res.status(404).json({ message: 'User not found' });
        res.status(200).json({ message: 'User deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        const response = await userService.resetPassword(email, newPassword);
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
