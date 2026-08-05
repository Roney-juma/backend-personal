/**
 * One-time migration: drop the stale UNIQUE index on roles.{ name: 1 }.
 *
 * Older schema versions made role names globally unique. The current schema makes
 * them unique per tenant via a compound index { company: 1, name: 1 }, so every
 * company can have its own "Super Admin" / "Claims Manager" / etc. The old single
 * -field unique index (usually named "name_1") lingers in existing databases and
 * throws E11000 duplicate-key errors when a second company's Super Admin is created.
 *
 * Idempotent + safe: only drops indexes whose key is exactly { name: 1 }; leaves the
 * compound index untouched; does nothing if the stale index is already gone.
 *
 *   node scripts/drop-stale-role-index.js
 *   ENV_FILE=.env.staging node scripts/drop-stale-role-index.js
 */
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('MONGO_URI not set');
  await mongoose.connect(uri);
  console.log(`Connected to DB: ${mongoose.connection.name}\n`);

  const coll = mongoose.connection.db.collection('roles');
  const indexes = await coll.indexes();
  console.log('Current indexes on `roles`:');
  for (const ix of indexes) console.log(`  - ${ix.name}: keys=${JSON.stringify(ix.key)} unique=${!!ix.unique}`);
  console.log('');

  // A stale index is one keyed ONLY on `name` (regardless of its name or uniqueness).
  const stale = indexes.filter((ix) => {
    const keys = Object.keys(ix.key);
    return keys.length === 1 && keys[0] === 'name';
  });

  if (!stale.length) {
    console.log('✓ No stale { name: 1 } index found — nothing to drop.');
  } else {
    for (const ix of stale) {
      await coll.dropIndex(ix.name);
      console.log(`✓ Dropped stale index "${ix.name}".`);
    }
  }

  // Make sure the intended compound index exists (creates it if somehow missing).
  await coll.createIndex({ company: 1, name: 1 }, { unique: true });
  console.log('✓ Ensured compound unique index { company: 1, name: 1 }.');

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
