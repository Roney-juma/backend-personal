#!/usr/bin/env node
/**
 * Cross-Region Replication (CRR) for the claim-files bucket — true DR against a
 * region outage. Versioning (from backup:setup) covers deletes/overwrites; this
 * covers losing us-east-1 entirely by mirroring every object into a bucket in a
 * second region.
 *
 * Idempotent — safe to re-run. It:
 *   1. Ensures the DESTINATION bucket exists in DR_REGION (versioning, AES256,
 *      public-access blocked).
 *   2. Ensures VERSIONING is on for both source and destination (CRR requires it).
 *   3. Creates/updates the IAM role S3 assumes to replicate (REPLICATION_ROLE_NAME).
 *   4. Puts the replication config on the SOURCE bucket.
 *
 * Requires the running AWS credentials to have IAM (CreateRole/PutRolePolicy) and
 * s3:PutReplicationConfiguration. If IAM is denied, the script prints the exact
 * trust + permission policies so you can create the role in the console, then
 * re-run with REPLICATION_ROLE_ARN set to skip the IAM step.
 *
 * Usage: node scripts/setup-s3-replication.js   (or: npm run dr:replicate)
 *
 * NOTE: CRR only replicates objects created AFTER it's enabled. See the runbook
 * section "Backfill existing objects" to mirror what's already in the bucket.
 */
require('dotenv').config();
const AWS = require('aws-sdk');

const {
  BUCKET_NAME,                       // source (claim files)
  AWS_REGION = 'us-east-1',          // source region
  DR_BUCKET,                         // destination
  DR_REGION = 'us-west-2',           // destination region
  REPLICATION_ROLE_NAME = 'ave-s3-replication-role',
  REPLICATION_ROLE_ARN,              // set to skip IAM creation (pre-made role)
  REPLICATE_DELETE_MARKERS = 'false',
  SECRET_ID_AWS, ACCESS_KEY, SECRET_KEY_AWS,
} = process.env;

const fail = (msg) => { console.error(`[dr] ERROR: ${msg}`); process.exit(1); };
if (!BUCKET_NAME) fail('BUCKET_NAME (source bucket) is not set');
if (!DR_BUCKET) fail('DR_BUCKET (destination bucket) is not set in .env');
if (DR_BUCKET === BUCKET_NAME) fail('DR_BUCKET must differ from BUCKET_NAME');
if (DR_REGION === AWS_REGION) fail('DR_REGION must differ from AWS_REGION for real DR');

const creds = { accessKeyId: SECRET_ID_AWS || ACCESS_KEY, secretAccessKey: SECRET_KEY_AWS };
const srcS3 = new AWS.S3({ ...creds, region: AWS_REGION });
const dstS3 = new AWS.S3({ ...creds, region: DR_REGION });
const iam = new AWS.IAM({ ...creds });

const SRC_ARN = `arn:aws:s3:::${BUCKET_NAME}`;
const DST_ARN = `arn:aws:s3:::${DR_BUCKET}`;

const trustPolicy = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'sts:AssumeRole' }],
};
const permissionPolicy = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: ['s3:GetReplicationConfiguration', 's3:ListBucket'], Resource: [SRC_ARN] },
    { Effect: 'Allow', Action: ['s3:GetObjectVersionForReplication', 's3:GetObjectVersionAcl', 's3:GetObjectVersionTagging'], Resource: [`${SRC_ARN}/*`] },
    { Effect: 'Allow', Action: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags'], Resource: [`${DST_ARN}/*`] },
  ],
};

const bucketExists = async (s3, Bucket) => {
  try { await s3.headBucket({ Bucket }).promise(); return true; }
  catch (err) {
    if (err.statusCode === 404 || err.code === 'NotFound') return false;
    if (err.statusCode === 403) fail(`Bucket "${Bucket}" exists but is owned by another account or access is denied.`);
    throw err;
  }
};

const ensureDestBucket = async () => {
  if (!(await bucketExists(dstS3, DR_BUCKET))) {
    const params = { Bucket: DR_BUCKET };
    if (DR_REGION !== 'us-east-1') params.CreateBucketConfiguration = { LocationConstraint: DR_REGION };
    await dstS3.createBucket(params).promise();
    console.log(`[dr] created destination bucket ${DR_BUCKET} (${DR_REGION})`);
  }
  await dstS3.putPublicAccessBlock({
    Bucket: DR_BUCKET,
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  }).promise();
  await dstS3.putBucketEncryption({
    Bucket: DR_BUCKET,
    ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
  }).promise();
  await dstS3.putBucketVersioning({ Bucket: DR_BUCKET, VersioningConfiguration: { Status: 'Enabled' } }).promise();
  console.log(`[dr] destination ${DR_BUCKET}: versioning ON, AES256, public-access blocked`);
};

const ensureSourceVersioning = async () => {
  await srcS3.putBucketVersioning({ Bucket: BUCKET_NAME, VersioningConfiguration: { Status: 'Enabled' } }).promise();
  console.log(`[dr] source ${BUCKET_NAME}: versioning ON`);
};

const ensureRole = async () => {
  if (REPLICATION_ROLE_ARN) {
    console.log(`[dr] using pre-made role ${REPLICATION_ROLE_ARN}`);
    return REPLICATION_ROLE_ARN;
  }
  try {
    let arn;
    try {
      const res = await iam.createRole({
        RoleName: REPLICATION_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: 'Allows S3 to replicate AVE claim files cross-region',
      }).promise();
      arn = res.Role.Arn;
      console.log(`[dr] created IAM role ${REPLICATION_ROLE_NAME}`);
    } catch (err) {
      if (err.code !== 'EntityAlreadyExists') throw err;
      await iam.updateAssumeRolePolicy({ RoleName: REPLICATION_ROLE_NAME, PolicyDocument: JSON.stringify(trustPolicy) }).promise();
      const res = await iam.getRole({ RoleName: REPLICATION_ROLE_NAME }).promise();
      arn = res.Role.Arn;
      console.log(`[dr] IAM role ${REPLICATION_ROLE_NAME} already existed — trust policy refreshed`);
    }
    await iam.putRolePolicy({
      RoleName: REPLICATION_ROLE_NAME,
      PolicyName: 'replication-policy',
      PolicyDocument: JSON.stringify(permissionPolicy),
    }).promise();
    console.log('[dr] attached replication permission policy');
    return arn;
  } catch (err) {
    if (err.code === 'AccessDenied' || err.code === 'AccessDeniedException') {
      console.error('\n[dr] Your AWS credentials lack IAM permissions. Create the role manually in the IAM console:');
      console.error(`\n  Role name: ${REPLICATION_ROLE_NAME}`);
      console.error('  Trusted entity (trust policy):\n' + JSON.stringify(trustPolicy, null, 2));
      console.error('  Permissions (inline policy):\n' + JSON.stringify(permissionPolicy, null, 2));
      console.error('\n  Then re-run with REPLICATION_ROLE_ARN=<the-new-role-arn> in .env.\n');
      process.exit(1);
    }
    throw err;
  }
};

const putReplication = async (roleArn) => {
  const cfg = {
    Bucket: BUCKET_NAME,
    ReplicationConfiguration: {
      Role: roleArn,
      Rules: [{
        ID: 'replicate-all-to-dr',
        Priority: 1,
        Filter: { Prefix: '' },
        Status: 'Enabled',
        // Disabled = DR keeps objects even if the source is delete-marked (safer for DR).
        DeleteMarkerReplication: { Status: REPLICATE_DELETE_MARKERS === 'true' ? 'Enabled' : 'Disabled' },
        Destination: { Bucket: DST_ARN },
      }],
    },
  };
  // IAM role creation is eventually consistent — S3 may briefly reject a brand-new
  // role as un-assumable. Retry a few times before giving up.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await srcS3.putBucketReplication(cfg).promise();
      console.log(`[dr] replication ENABLED: ${BUCKET_NAME} (${AWS_REGION}) -> ${DR_BUCKET} (${DR_REGION})`);
      return;
    } catch (err) {
      const retryable = /assume|not authorized|InvalidRequest|MalformedXML/i.test(err.message);
      if (attempt === 6 || !retryable) throw err;
      const waitMs = attempt * 5000;
      console.log(`[dr] role not ready yet (${err.code}) — retrying in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
};

(async () => {
  try {
    console.log(`[dr] source: ${BUCKET_NAME} (${AWS_REGION})  ->  dest: ${DR_BUCKET} (${DR_REGION})`);
    await ensureDestBucket();
    await ensureSourceVersioning();
    const roleArn = await ensureRole();
    await putReplication(roleArn);
    console.log('\n[dr] done. New uploads now replicate automatically.');
    console.log('[dr] Existing objects are NOT auto-backfilled — see docs/BACKUP_RECOVERY.md ("Backfill existing objects").');
  } catch (err) {
    fail(err.message);
  }
})();
