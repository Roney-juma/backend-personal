/**
 * One-off migration: the workspace "Issue" tracker was renamed to "Task".
 *
 * Renaming the mongoose model changed the collection mongoose reads from
 * (`issues` -> `tasks`), so anything created before the rename would otherwise
 * be stranded in the old collection and simply vanish from the UI.
 *
 * Also restamps the human reference prefix ISS- -> TSK- so old and new rows do
 * not look like two different systems.
 *
 * Safe to run more than once: it does nothing when `issues` is absent, and
 * refuses to merge into a non-empty `tasks` collection unless --merge is passed.
 *
 *   node scripts/rename-issues-to-tasks.js [--merge] [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');
const MERGE = process.argv.includes('--merge');

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Connected to ${db.databaseName}${DRY_RUN ? ' (dry run)' : ''}`);

  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const hasIssues = names.includes('issues');
  const hasTasks = names.includes('tasks');

  if (!hasIssues) {
    console.log('No `issues` collection — nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  const issueCount = await db.collection('issues').countDocuments();
  const taskCount = hasTasks ? await db.collection('tasks').countDocuments() : 0;
  console.log(`issues: ${issueCount} document(s) | tasks: ${taskCount} document(s)`);

  if (issueCount === 0) {
    console.log('`issues` is empty. Drop it manually if you want it gone.');
    await mongoose.disconnect();
    return;
  }

  if (hasTasks && taskCount > 0 && !MERGE) {
    console.error(
      '`tasks` already has documents. Re-run with --merge to copy the old rows in,\n' +
      'or inspect both collections first — this refuses to guess.',
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`Would move ${issueCount} document(s) into \`tasks\` and restamp ISS- -> TSK-.`);
    await mongoose.disconnect();
    return;
  }

  if (!hasTasks || taskCount === 0) {
    // Cheapest path: a server-side rename, no document copying.
    if (hasTasks) await db.collection('tasks').drop();
    await db.collection('issues').rename('tasks');
    console.log(`Renamed collection issues -> tasks (${issueCount} document(s)).`);
  } else {
    const docs = await db.collection('issues').find({}).toArray();
    await db.collection('tasks').insertMany(docs, { ordered: false });
    await db.collection('issues').drop();
    console.log(`Merged ${docs.length} document(s) into tasks and dropped issues.`);
  }

  const restamped = await db.collection('tasks').updateMany(
    { reference: { $regex: '^ISS-' } },
    [{ $set: { reference: { $replaceOne: { input: '$reference', find: 'ISS-', replacement: 'TSK-' } } } }],
  );
  console.log(`Restamped ${restamped.modifiedCount} reference(s) from ISS- to TSK-.`);

  await mongoose.disconnect();
  console.log('Done.');
};

run().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
