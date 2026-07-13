#!/usr/bin/env node
/**
 * Generate a fresh RS512 JWT signing keypair.
 *
 * WHY: the previous keys/private.pem was committed to git history and must be
 * treated as compromised — anyone with the repo history can forge tokens for any
 * account until the key is rotated. This script mints a replacement keypair in the
 * format the app expects (private key encrypted with TOKEN_SECRET as its passphrase,
 * matching src/service/token.service.js and src/config/keys.js).
 *
 * USAGE:
 *   TOKEN_SECRET='<same value as the app env>' node scripts/rotate-jwt-keys.js [outDir] [--force]
 *
 * - outDir defaults to KEYS_DIR or <repo-root>/keys
 * - refuses to overwrite existing keys unless --force is passed (and always backs them up first)
 * - the generated files are NOT committed (keys/ is gitignored); deploy them out-of-band
 *
 * AFTER RUNNING: see docs/SECURITY-REMEDIATION.md — rotating the key invalidates all
 * existing tokens, so every user must log in again.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));

const passphrase = process.env.TOKEN_SECRET;
if (!passphrase) {
  console.error('ERROR: TOKEN_SECRET must be set — it is the passphrase for the private key.');
  process.exit(1);
}

const outDir = positional[0]
  ? path.resolve(positional[0])
  : process.env.KEYS_DIR
  ? path.resolve(process.env.KEYS_DIR)
  : path.resolve(__dirname, '..', 'keys');

const privatePath = path.join(outDir, 'private.pem');
const publicPath = path.join(outDir, 'public.pem');

fs.mkdirSync(outDir, { recursive: true });

// Back up + guard existing keys.
for (const p of [privatePath, publicPath]) {
  if (fs.existsSync(p)) {
    if (!force) {
      console.error(`ERROR: ${p} already exists. Re-run with --force to rotate (existing keys are backed up first).`);
      process.exit(1);
    }
    const backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(p, backup);
    console.log(`Backed up ${path.basename(p)} -> ${path.basename(backup)}`);
  }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase,
  },
});

fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });

// Sanity check: sign + verify a token round-trip with the new keypair.
const jwt = require('jsonwebtoken');
const token = jwt.sign({ t: 'rotation-check' }, { key: privateKey, passphrase }, { algorithm: 'RS512' });
jwt.verify(token, publicKey, { algorithms: ['RS512'] });

console.log('\nNew RS512 keypair written:');
console.log(`  ${privatePath}`);
console.log(`  ${publicPath}`);
console.log('Sign/verify round-trip: OK');
console.log('\nNext: deploy these keys, restart the app, and purge the old key from git history');
console.log('(see docs/SECURITY-REMEDIATION.md). All existing tokens are now invalid.');
