// Default temporary password for admin-created accounts. Users are emailed to
// log in with this and are forced to change it on first login (mustChangePassword).
// It satisfies the password policy (upper, lower, number, 8+ chars).
module.exports = { DEFAULT_TEMP_PASSWORD: 'Password@123' };
