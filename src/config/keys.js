const path = require('path');
const fs = require('fs');

// Resolve the RSA keys directory independent of process.cwd(). PM2 (and other launchers)
// may start the app from src/, which previously made `${process.cwd()}/keys` point at the
// wrong place and crash on startup. Anchored to this file's location instead:
//   src/config/keys.js -> ../../keys  =  <repo-root>/keys
// Override with KEYS_DIR when keys live elsewhere on the host.
const KEYS_DIR = process.env.KEYS_DIR
  ? path.resolve(process.env.KEYS_DIR)
  : path.resolve(__dirname, '..', '..', 'keys');

const privateKeyPath = path.join(KEYS_DIR, 'private.pem');
const publicKeyPath = path.join(KEYS_DIR, 'public.pem');

// Read a key file, turning a missing-file crash into an actionable message. The keys are
// NOT in git (gitignored) — each host must provision keys/private.pem + keys/public.pem
// whose passphrase equals this environment's TOKEN_SECRET.
const readKey = (keyPath, label) => {
  try {
    return fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `RSA ${label} key not found at ${keyPath}. ` +
        `Provision keys/private.pem and keys/public.pem on this host (or set KEYS_DIR to their location). ` +
        `The keypair is not committed to git — see the deployment/recovery steps.`
      );
    }
    throw err;
  }
};

const readPrivateKey = () => readKey(privateKeyPath, 'private');
const readPublicKey = () => readKey(publicKeyPath, 'public');

module.exports = { KEYS_DIR, privateKeyPath, publicKeyPath, readPrivateKey, readPublicKey };
