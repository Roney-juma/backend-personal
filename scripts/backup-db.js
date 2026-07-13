#!/usr/bin/env node
/**
 * Secondary MongoDB backup.
 *
 * Runs `mongodump` against the Atlas cluster, producing a single gzipped
 * archive, and uploads it to the backup S3 bucket (server-side encrypted).
 * Atlas Cloud Backup is the PRIMARY, managed backup with point-in-time
 * recovery; this script is a provider-independent secondary copy that lives in
 * your own S3 so a backup exists even if the Atlas account is lost.
 *
 * Usage:   node scripts/backup-db.js        (or: npm run backup:db)
 * Cron:    see docs/BACKUP_RECOVERY.md
 *
 * Requires MongoDB Database Tools (mongodump) on PATH, or MONGODUMP_PATH set.
 * Retention is enforced by the S3 lifecycle rule created by backup:setup.
 */
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AWS = require('aws-sdk');

const {
  MONGO_URI,
  BACKUP_BUCKET,
  BACKUP_PREFIX = 'db/',
  BACKUP_REGION,
  MONGODUMP_PATH = 'mongodump',
  SECRET_ID_AWS,
  ACCESS_KEY,
  SECRET_KEY_AWS,
  AWS_REGION = 'us-east-1',
} = process.env;

const fail = (msg) => { console.error(`[backup] ERROR: ${msg}`); process.exit(1); };

if (!MONGO_URI) fail('MONGO_URI is not set');
if (!BACKUP_BUCKET) fail('BACKUP_BUCKET is not set — run `npm run backup:setup` first');

AWS.config.update({
  accessKeyId: SECRET_ID_AWS || ACCESS_KEY,
  secretAccessKey: SECRET_KEY_AWS,
  region: BACKUP_REGION || AWS_REGION,
});
const s3 = new AWS.S3();

// ISO stamp, filesystem/S3-safe: 2026-07-13T09-30-00-000Z
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const fileName = `ave-${stamp}.archive.gz`;
const tmpFile = path.join(os.tmpdir(), fileName);
const key = `${BACKUP_PREFIX}${fileName}`;

const runDump = () => new Promise((resolve, reject) => {
  // --archive to a single file + --gzip. No db in the URI => dumps every
  // (non-system) database on the cluster, so we capture whichever db the app uses.
  const args = [`--uri=${MONGO_URI}`, `--archive=${tmpFile}`, '--gzip'];
  const proc = spawn(MONGODUMP_PATH, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      return reject(new Error(
        `mongodump not found ("${MONGODUMP_PATH}"). Install MongoDB Database Tools ` +
        '(https://www.mongodb.com/docs/database-tools/installation/) or set MONGODUMP_PATH.'));
    }
    reject(err);
  });
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mongodump exited with code ${code}`))));
});

const upload = async () => {
  const { size } = fs.statSync(tmpFile);
  await s3.upload({
    Bucket: BACKUP_BUCKET,
    Key: key,
    Body: fs.createReadStream(tmpFile),
    ContentType: 'application/gzip',
    ServerSideEncryption: 'AES256',
    Metadata: { 'created-at': stamp, source: 'mongodump' },
  }).promise();
  return size;
};

(async () => {
  const started = Date.now();
  try {
    console.log(`[backup] dumping database -> ${tmpFile}`);
    await runDump();
    console.log(`[backup] uploading -> s3://${BACKUP_BUCKET}/${key}`);
    const size = await upload();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[backup] OK in ${secs}s | ${(size / 1048576).toFixed(1)} MiB | s3://${BACKUP_BUCKET}/${key}`);
  } catch (err) {
    fail(err.message);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
})();
