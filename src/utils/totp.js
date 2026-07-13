const crypto = require('crypto');

// RFC 6238 TOTP (time-based one-time password) with no external dependencies.
// Compatible with Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;

// Encode a Buffer to a base32 string (RFC 4648, no padding).
const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
};

// Decode a base32 string back to a Buffer.
const base32Decode = (str) => {
  const cleaned = str.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

// Generate a new random base32 secret (default 20 bytes = 160 bits).
const generateSecret = (bytes = 20) => base32Encode(crypto.randomBytes(bytes));

// Compute the TOTP code for a given secret at a given counter (time step).
const generateCode = (secret, counter, digits = DEFAULT_DIGITS) => {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  // Write the 64-bit counter big-endian.
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = (binary % 10 ** digits).toString().padStart(digits, '0');
  return otp;
};

// Verify a submitted token against the secret, allowing a small clock-drift window.
const verify = (token, secret, { window = 1, step = DEFAULT_STEP_SECONDS, digits = DEFAULT_DIGITS } = {}) => {
  if (!token || !secret) return false;
  const normalized = String(token).replace(/\s/g, '');
  if (!/^\d+$/.test(normalized)) return false;

  const counter = Math.floor(Date.now() / 1000 / step);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = generateCode(secret, counter + errorWindow, digits);
    // Constant-time comparison to avoid leaking timing information.
    if (
      candidate.length === normalized.length &&
      crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))
    ) {
      return true;
    }
  }
  return false;
};

// Build the otpauth:// URI that authenticator apps encode into a QR code.
const keyUri = (secret, accountName, issuer = 'Ave Insurance') => {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};

module.exports = { generateSecret, generateCode, verify, keyUri, base32Encode, base32Decode };
