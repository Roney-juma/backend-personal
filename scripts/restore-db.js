#!/usr/bin/env node
/**
 * Restore a MongoDB backup produced by backup-db.js.
 *
 * DESTRUCTIVE. This overwrites data in the cluster pointed to by MONGO_URI.
 * By design it is a two-step, opt-in operation: without --yes it only prints
 * what it *would* do (a dry run), so you can't nuke production by fat-fingering.
 *
 * Usage:
 *   node scripts/restore-db.js latest              # dry run against newest backup
 *   node scripts/restore-db.js latest --yes        # actually restore newest
 *   node scripts/restore-db.js db/ave-....gz --yes # restore a specific archive
 *   node scripts/restore-db.js latest --yes --drop # drop collections first (clean restore)
 *
 * Point RESTORE_URI at a *scratch* cluster to test-restore without touching prod
 * (falls back to MONGO_URI if unset). Requires mongorestore on PATH / MONGORESTORE_PATH.
 */
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AWS = require('aws-sdk');

const {
  MONGO_URI,
  RESTORE_URI,
  BACKUP_BUCKET,
  BACKUP_PREFIX = 'db/',
  BACKUP_REGION,
  MONGORESTORE_PATH = 'mongorestore',
  SECRET_ID_AWS,
  ACCESS_KEY,
  SECRET_KEY_AWS,
  AWS_REGION = 'us-east-1',
} = process.env;

const fail = (msg) => { console.error(`[restore] ERROR: ${msg}`); process.exit(1); };

const targetUri = RESTORE_URI || MONGO_URI;
if (!targetUri) fail('Neither RESTORE_URI nor MONGO_URI is set');
if (!BACKUP_BUCKET) fail('BACKUP_BUCKET is not set');

const args = process.argv.slice(2);
const source = args[0];
const drop = args.includes('--drop');
const confirmed = args.includes('--yes') || process.env.CONFIRM_RESTORE === 'yes';
if (!source) fail('Specify a backup: "latest" or an S3 key (e.g. db/ave-....archive.gz)');

AWS.config.update({
  accessKeyId: SECRET_ID_AWS || ACCESS_KEY,
  secretAccessKey: SECRET_KEY_AWS,
  region: BACKUP_REGION || AWS_REGION,
});
const s3 = new AWS.S3();

// Redact credentials before printing the target host.
const targetHost = (targetUri.match(/@([^/?]+)/) || [null, targetUri])[1];

const resolveKey = async () => {
  if (source !== 'latest') return source;
  const { Contents = [] } = await s3.listObjectsV2({ Bucket: BACKUP_BUCKET, Prefix: BACKUP_PREFIX }).promise();
  const archives = Contents.filter((o) => o.Key.endsWith('.archive.gz'))
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  if (!archives.length) fail(`No backups found under s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}`);
  return archives[0].Key;
};

const download = async (key, dest) => {
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    s3.getObject({ Bucket: BACKUP_BUCKET, Key: key }).createReadStream()
      .on('error', reject).pipe(ws).on('error', reject).on('finish', resolve);
  });
};

const runRestore = (file) => new Promise((resolve, reject) => {
  const a = [`--uri=${targetUri}`, `--archive=${file}`, '--gzip'];
  if (drop) a.push('--drop');
  const proc = spawn(MONGORESTORE_PATH, a, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      return reject(new Error(
        `mongorestore not found ("${MONGORESTORE_PATH}"). Install MongoDB Database Tools or set MONGORESTORE_PATH.`));
    }
    reject(err);
  });
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mongorestore exited with code ${code}`))));
});

(async () => {
  const key = await resolveKey();

  console.log('──────────────────────────────────────────────');
  console.log(`[restore] source : s3://${BACKUP_BUCKET}/${key}`);
  console.log(`[restore] target : ${targetHost}`);
  console.log(`[restore] mode   : ${drop ? '--drop (existing collections dropped first)' : 'merge (upsert into existing data)'}`);
  console.log('──────────────────────────────────────────────');

  if (!confirmed) {
    console.log('[restore] DRY RUN — nothing was changed.');
    console.log('[restore] Re-run with --yes to actually restore (add --drop for a clean restore).');
    console.log('[restore] TIP: set RESTORE_URI to a scratch cluster to rehearse safely.');
    process.exit(0);
  }

  const tmpFile = path.join(os.tmpdir(), path.basename(key));
  try {
    console.log(`[restore] downloading -> ${tmpFile}`);
    await download(key, tmpFile);
    console.log('[restore] restoring...');
    await runRestore(tmpFile);
    console.log('[restore] OK — restore complete.');
  } catch (err) {
    fail(err.message);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
})();
