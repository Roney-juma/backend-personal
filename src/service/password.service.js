const bcrypt = require('bcrypt');
const MODELS = require('../utils/userModels');
const { assertValidPassword } = require('../utils/passwordPolicy');

const getModel = (accountType) => {
  const model = MODELS[accountType];
  if (!model) throw new Error(`Unsupported account type: ${accountType}`);
  return model;
};

/**
 * Change a logged-in user's password after verifying their current one.
 * Also clears the `mustChangePassword` flag, so this satisfies the
 * forced-change-on-first-login flow. Uses updateOne to write the already-hashed
 * password, bypassing per-model pre-save hooks (avoids double-hashing).
 */
const changePassword = async (accountType, userId, currentPassword, newPassword) => {
  assertValidPassword(newPassword);

  const Model = getModel(accountType);
  const user = await Model.findById(userId);
  if (!user) throw new Error('User not found');

  const matches = await bcrypt.compare(currentPassword || '', user.password);
  if (!matches) throw new Error('Current password is incorrect');

  const sameAsOld = await bcrypt.compare(newPassword, user.password);
  if (sameAsOld) throw new Error('New password must be different from the current password');

  const hashed = await bcrypt.hash(newPassword, 10);
  await Model.updateOne(
    { _id: userId },
    { $set: { password: hashed, mustChangePassword: false }, $unset: { resetPasswordToken: '', resetPasswordExpires: '' } }
  );

  return { message: 'Password changed successfully' };
};

module.exports = { changePassword };
