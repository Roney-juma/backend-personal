const tokenService = require('../service/token.service');
const providerUserService = require('../service/providerUser.service');

const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await providerUserService.login(email, password);

        if (result.error) {
            return res.status(401).json({ message: result.error });
        }

        // If MFA is enabled, return a short-lived challenge token instead of access
        // tokens; the client must complete /provider/mfa/verify-login.
        if (result.user.mfaEnabled) {
            const mfaToken = tokenService.generateMfaChallengeToken(result.user._id, 'ProviderUser');
            return res.status(200).json({ mfaRequired: true, mfaToken });
        }

        const tokens = tokenService.generateProviderUserToken(result.user);
        res.status(200).json({ user: result.user, tokens });
    } catch (error) {
        res.status(500).json({ message: 'Login failed', error: error.message });
    }
};

const createUser = async (req, res) => {
    try {
        const user = await providerUserService.createProviderUser(req.body);
        res.status(201).json(user);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const getAllUsers = async (req, res) => {
    try {
        const users = await providerUserService.getAllProviderUsers();
        res.status(200).json(users);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getUserById = async (req, res) => {
    try {
        const user = await providerUserService.getProviderUserById(req.params.id);
        if (!user) return res.status(404).json({ message: 'Provider user not found' });
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const updateUser = async (req, res) => {
    try {
        const user = await providerUserService.updateProviderUser(req.params.id, req.body);
        if (!user) return res.status(404).json({ message: 'Provider user not found' });
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const deactivateUser = async (req, res) => {
    try {
        const user = await providerUserService.deactivateProviderUser(req.params.id);
        if (!user) return res.status(404).json({ message: 'Provider user not found' });
        res.status(200).json({ message: 'User deactivated', user });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        const result = await providerUserService.resetPassword(email, newPassword);
        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    login,
    createUser,
    getAllUsers,
    getUserById,
    updateUser,
    deactivateUser,
    resetPassword,
};
