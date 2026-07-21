const jwt = require('jsonwebtoken');
const { TokenIssuer } = require('../constants/encryption.constants');
const logger = require('./logger');
const { readPublicKey } = require('../config/keys');

const publicKey = readPublicKey();

/**
 * Middleware for provider (platform staff) routes only.
 * Accepts tokens where accountType === 'ProviderUser'.
 * Rejects insurance company tokens even if the signature is valid.
 */
const verifyProviderToken = (roles = []) => (req, res, next) => {
    const header = req.headers.authorization;

    if (!header) {
        logger.info('No token provided');
        return res.status(403).json({ message: 'No token provided.' });
    }

    const token = header.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }

    try {
        jwt.verify(token, publicKey.replace(/\\n/gm, '\n'), {
            issuer: TokenIssuer,
            algorithms: ['RS512'],
        }, (err, decoded) => {
            if (err) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const user = decoded.payload;

            if (user.accountType !== 'ProviderUser') {
                return res.status(403).json({ message: 'Forbidden: provider access only' });
            }

            // Defense in depth: staff tokens never carry a tenant claim. A token
            // stamped ProviderUser that HAS one is a legacy insurer-admin token
            // (issued before the CompanyUser split) — reject it.
            if (user.company) {
                return res.status(403).json({ message: 'Forbidden: provider access only' });
            }

            req.user = user;

            if (roles.length && !roles.includes(req.user.role_ID)) {
                return res.status(403).json({ message: 'Forbidden: insufficient role' });
            }

            next();
        });
    } catch (err) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
};

module.exports = verifyProviderToken;
