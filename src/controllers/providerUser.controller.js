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

/**
 * Slide the session forward.
 *
 * Provider tokens last a day and there was no way to renew one, so a staff
 * member mid-task simply started getting 401s. This re-issues against the
 * caller's still-valid token — there is no separate refresh token to store,
 * which keeps nothing long-lived in the browser.
 *
 * Two things stop it becoming an immortal session:
 *   - the user is re-read from the database, so a deactivated or deleted
 *     account cannot renew;
 *   - `sessionStartedAt` is carried through every renewal, and past
 *     PROVIDER_SESSION_MAX_HOURS the caller must sign in again.
 */
const refresh = async (req, res) => {
    try {
        const user = await providerUserService.getProviderUserById(req.user.id);
        if (!user || user.active === false) {
            return res.status(401).json({ message: 'This account can no longer be used. Please sign in again.' });
        }

        const maxHours = Number(process.env.PROVIDER_SESSION_MAX_HOURS || 168); // 7 days
        const nowSec = Math.floor(Date.now() / 1000);
        // Tokens issued before sessionStartedAt existed have no start to measure
        // from; treat this renewal as the start rather than locking them out.
        const startedAt = Number(req.user.sessionStartedAt) || nowSec;

        if (nowSec - startedAt > maxHours * 3600) {
            return res.status(401).json({ message: 'Your session has reached its maximum length. Please sign in again.' });
        }

        const tokens = tokenService.generateProviderUserToken(user, { sessionStartedAt: startedAt });
        res.status(200).json({ user, tokens, sessionStartedAt: startedAt });
    } catch (error) {
        res.status(500).json({ message: 'Could not refresh the session', error: error.message });
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

// Fields a provider user may change on their OWN profile. role/active/password are
// excluded (password has its own /change-password flow; role/active are admin-only).
const PROFILE_EDITABLE_FIELDS = ['fullName', 'phone', 'department', 'position'];

// GET /provider/me — the authenticated provider user's own profile.
const getMe = async (req, res) => {
    try {
        const user = await providerUserService.getProviderUserById(req.user.id);
        if (!user) return res.status(404).json({ message: 'Provider user not found' });
        const { password, mfaSecret, ...safe } = user.toObject();
        res.status(200).json(safe);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// PATCH /provider/me — update the authenticated provider user's editable fields.
const updateMe = async (req, res) => {
    try {
        const updates = {};
        for (const field of PROFILE_EDITABLE_FIELDS) {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        }
        const user = await providerUserService.updateProviderUser(req.user.id, updates);
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

/** Public. Always 200 with the same body — see the service for why. */
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email is required' });
        res.status(200).json(await providerUserService.forgotPassword(email));
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/** Public. Completes the emailed-code flow started by forgotPassword. */
const resetPasswordWithToken = async (req, res) => {
    try {
        const { email, token, newPassword } = req.body;
        if (!email || !token || !newPassword) {
            return res.status(400).json({ message: 'Email, code and new password are required' });
        }
        res.status(200).json(await providerUserService.resetPasswordWithToken(email, token, newPassword));
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    login,
    refresh,
    createUser,
    getAllUsers,
    getUserById,
    updateUser,
    deactivateUser,
    resetPassword,
    forgotPassword,
    resetPasswordWithToken,
    getMe,
    updateMe,
};
