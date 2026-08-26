/**
 * Backfill the `liveOn` slot that enforces "one live settlement per exposure".
 *
 * settlement.model.js now carries a sparse UNIQUE index on `liveOn`, which is
 * set from `status` on every save. Two things need doing before that guarantee
 * is real on an existing database:
 *
 *   1. Settlements saved before this change have no `liveOn`, so the index
 *      ignores them and a second proposal could still slip past a lost race.
 *   2. If any exposure ALREADY has more than one live settlement, the unique
 *      index cannot be built at all — mongoose's autoIndex will fail silently
 *      at startup and you are left with no protection.
 *
 * So this reports duplicates first and refuses to backfill them. Resolve those
 * (withdraw the ones that should not be live, or pass --withdraw-older to keep
 * only the most recently proposed) and run it again.
 *
 *   node scripts/backfill-settlement-live-slot.js [--dry-run] [--withdraw-older]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Settlement = require('../src/models/settlement.model');

const DRY_RUN = process.argv.includes('--dry-run');
const WITHDRAW_OLDER = process.argv.includes('--withdraw-older');
const LIVE = Settlement.LIVE_STATUSES;

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.db.databaseName}${DRY_RUN ? ' (dry run)' : ''}`);

  // 1. Exposures carrying more than one live settlement.
  const dupes = await Settlement.aggregate([
    { $match: { deletedAt: null, status: { $in: LIVE } } },
    {
      $group: {
        _id: '$thirdPartyClaim',
        count: { $sum: 1 },
        settlements: { $push: { id: '$_id', reference: '$reference', status: '$status', proposedAt: '$proposedAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (dupes.length > 0) {
    console.log(`\n${dupes.length} exposure(s) have more than one live settlement:`);
    dupes.forEach((d) => {
      console.log(`  third-party claim ${d._id}`);
      d.settlements
        .slice()
        .sort((a, b) => new Date(b.proposedAt) - new Date(a.proposedAt))
        .forEach((s, i) => {
          console.log(`    ${i === 0 ? 'KEEP ' : 'extra'} ${s.reference} (${s.status}) proposed ${new Date(s.proposedAt).toISOString().slice(0, 10)}`);
        });
    });

    if (!WITHDRAW_OLDER) {
      console.log('\nResolve these first — withdraw whichever should not be live, or re-run');
      console.log('with --withdraw-older to keep only the most recently proposed on each.');
      console.log('Nothing was changed.');
      await mongoose.disconnect();
      process.exit(1);
    }

    let withdrawn = 0;
    for (const d of dupes) {
      const ordered = d.settlements
        .slice()
        .sort((a, b) => new Date(b.proposedAt) - new Date(a.proposedAt));
      for (const s of ordered.slice(1)) {
        console.log(`  withdrawing ${s.reference}`);
        if (!DRY_RUN) {
          // Straight to the collection: `withdraw` in the service also writes
          // ledger entries and notifies, which is wrong for a data repair.
          await Settlement.collection.updateOne(
            { _id: s.id },
            {
              $set: {
                status: 'withdrawn',
                withdrawnAt: new Date(),
                withdrawalReason: 'Superseded — duplicate live settlement closed during migration',
              },
              $unset: { liveOn: '' },
            }
          );
        }
        withdrawn += 1;
      }
    }
    console.log(`Withdrew ${withdrawn} duplicate settlement(s).`);
  } else {
    console.log('No exposure has more than one live settlement.');
  }

  // 2. Stamp the slot on every live settlement that lacks it.
  const needing = await Settlement.countDocuments({
    deletedAt: null,
    status: { $in: LIVE },
    liveOn: { $exists: false },
  });
  console.log(`\n${needing} live settlement(s) need the liveOn slot stamped.`);

  if (!DRY_RUN && needing > 0) {
    const res = await Settlement.collection.updateMany(
      { deletedAt: null, status: { $in: LIVE }, liveOn: { $exists: false } },
      [{ $set: { liveOn: '$thirdPartyClaim' } }]
    );
    console.log(`Stamped ${res.modifiedCount}.`);
  }

  // 3. Clear the slot on anything no longer live (defensive — should be none).
  if (!DRY_RUN) {
    const cleared = await Settlement.collection.updateMany(
      { status: { $nin: LIVE }, liveOn: { $exists: true } },
      { $unset: { liveOn: '' } }
    );
    if (cleared.modifiedCount) console.log(`Cleared the slot on ${cleared.modifiedCount} settled/closed settlement(s).`);
  }

  if (!DRY_RUN) {
    await Settlement.syncIndexes();
    console.log('Indexes synced — the unique liveOn slot is now enforced by the database.');
  }

  await mongoose.disconnect();
  console.log('Done.');
};

run().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
