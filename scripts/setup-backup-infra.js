#!/usr/bin/env node
/**
 * One-time (idempotent) setup of backup infrastructure. Safe to re-run.
 *
 *  1. BACKUP_BUCKET  — the DB-dump bucket. Creates it if missing, then enforces:
 *       block-all-public-access, default AES256 encryption, versioning, and a
 *       lifecycle rule that expires dumps after BACKUP_RETENTION_DAYS.
 *
 *  2. BUCKET_NAME (aveinsuranceclaims) — your live claim files. Enables
 *       VERSIONING so an overwrite or delete can be undone, and a lifecycle
 *       rule that reaps *old versions* after CLAIMS_NONCURRENT_DAYS (keeping
 *       current/live objects untouched) so versioning storage doesn't grow forever.
 *
 * Usage: node scripts/setup-backup-infra.js   (or: npm run backup:setup)
 */
require('dotenv').config();
const AWS = require('aws-sdk');

const {
  BACKUP_BUCKET,
  BACKUP_PREFIX = 'db/',
  BACKUP_REGION,
  BACKUP_RETENTION_DAYS = '30',
  CLAIMS_NONCURRENT_DAYS = '90',
  BUCKET_NAME,
  SECRET_ID_AWS,
  ACCESS_KEY,
  SECRET_KEY_AWS,
  AWS_REGION = 'us-east-1',
} = process.env;

const fail = (msg) => { console.error(`[setup] ERROR: ${msg}`); process.exit(1); };
if (!BACKUP_BUCKET) fail('BACKUP_BUCKET is not set in .env');

const region = BACKUP_REGION || AWS_REGION;
AWS.config.update({
  accessKeyId: SECRET_ID_AWS || ACCESS_KEY,
  secretAccessKey: SECRET_KEY_AWS,
  region,
});
const s3 = new AWS.S3();

const exists = async (Bucket) => {
  try { await s3.headBucket({ Bucket }).promise(); return true; }
  catch (err) {
    if (err.statusCode === 404 || err.code === 'NotFound') return false;
    if (err.statusCode === 403) fail(`Bucket "${Bucket}" exists but is owned by another account or access is denied.`);
    throw err;
  }
};

const createBucket = async (Bucket) => {
  const params = { Bucket };
  // us-east-1 must NOT send a LocationConstraint; every other region must.
  if (region !== 'us-east-1') params.CreateBucketConfiguration = { LocationConstraint: region };
  await s3.createBucket(params).promise();
  console.log(`[setup] created bucket ${Bucket} (${region})`);
};

const lockDownBackupBucket = async (Bucket) => {
  await s3.putPublicAccessBlock({
    Bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    },
  }).promise();
  await s3.putBucketEncryption({
    Bucket,
    ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
  }).promise();
  await s3.putBucketVersioning({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }).promise();
  await s3.putBucketLifecycleConfiguration({
    Bucket,
    LifecycleConfiguration: {
      Rules: [{
        ID: 'expire-db-backups',
        Filter: { Prefix: BACKUP_PREFIX },
        Status: 'Enabled',
        Expiration: { Days: Number(BACKUP_RETENTION_DAYS) },
        NoncurrentVersionExpiration: { NoncurrentDays: 7 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      }],
    },
  }).promise();
  console.log(`[setup] ${Bucket}: public-access blocked, AES256, versioning ON, expire dumps after ${BACKUP_RETENTION_DAYS}d`);
};

const protectClaimsBucket = async (Bucket) => {
  await s3.putBucketVersioning({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }).promise();
  await s3.putBucketLifecycleConfiguration({
    Bucket,
    LifecycleConfiguration: {
      Rules: [{
        ID: 'reap-old-versions',
        Filter: { Prefix: '' },
        Status: 'Enabled',
        // NOTE: no `Expiration` here on purpose — current (live) files must never
        // be auto-deleted. Only superseded/old versions are reaped.
        NoncurrentVersionExpiration: { NoncurrentDays: Number(CLAIMS_NONCURRENT_DAYS) },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      }],
    },
  }).promise();
  console.log(`[setup] ${Bucket}: versioning ON (deletes/overwrites recoverable), old versions reaped after ${CLAIMS_NONCURRENT_DAYS}d`);
};

(async () => {
  try {
    console.log(`[setup] backup bucket: ${BACKUP_BUCKET} (${region})`);
    if (!(await exists(BACKUP_BUCKET))) await createBucket(BACKUP_BUCKET);
    await lockDownBackupBucket(BACKUP_BUCKET);

    if (BUCKET_NAME) {
      console.log(`[setup] claims bucket: ${BUCKET_NAME}`);
      await protectClaimsBucket(BUCKET_NAME);
    } else {
      console.log('[setup] BUCKET_NAME not set — skipping claim-files protection');
    }

    console.log('[setup] done.');
  } catch (err) {
    fail(err.message);
  }
})();
