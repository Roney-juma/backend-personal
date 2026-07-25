const jwt = require('jsonwebtoken');
const { TokenIssuer } = require('../constants/encryption.constants');
const { readPublicKey } = require('../config/keys');
const publicKey = readPublicKey();

// Best-effort authentication for public routes: attaches req.user when a valid
// bearer token is present (so tenant scoping via its `company` claim can apply)
// but never rejects the request — anonymous and invalid tokens just proceed
// unauthenticated (legacy/global behavior).
const optionalToken = () => (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();

  jwt.verify(token, publicKey.replace(/\\n/gm, '\n'), {
    issuer: TokenIssuer,
    algorithms: ['RS512'],
  }, (err, decoded) => {
    if (!err && decoded) req.user = decoded.payload;
    next();
  });
};

module.exports = optionalToken;
