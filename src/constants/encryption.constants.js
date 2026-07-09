require('dotenv').config();

const EncryptionSecret = process.env.ENCRYPTION_SECRET;
const TokenSecret = process.env.TOKEN_SECRET;
const TokenIssuer = process.env.TOKEN_ISSUER || 'EVE API';

if (!TokenSecret) {
  throw new Error('TOKEN_SECRET is not set — required to sign/verify auth tokens.');
}
if (!EncryptionSecret) {
  throw new Error('ENCRYPTION_SECRET is not set.');
}

module.exports = { EncryptionSecret, TokenSecret, TokenIssuer };
