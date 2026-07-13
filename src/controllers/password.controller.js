const passwordService = require('../service/password.service');

// Change the authenticated user's own password. accountType is bound at the
// route layer (same reasoning as mfa.controller). Powers the forced
// change-on-first-login flow (clears mustChangePassword on success).
const changePassword = (accountType) => async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'currentPassword and newPassword are required' });
    }
    const result = await passwordService.changePassword(accountType, req.user.id, currentPassword, newPassword);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

module.exports = { changePassword };
