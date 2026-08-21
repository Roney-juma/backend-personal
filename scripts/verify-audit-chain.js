/**
 * Verify the tamper-evidence chain over the audit log.
 *
 *   node scripts/verify-audit-chain.js            # verify everything
 *   node scripts/verify-audit-chain.js --from 500 # verify from a sequence on
 *   node scripts/verify-audit-chain.js --seal     # seal pending rows first
 *
 * Exits non-zero if anything fails, so it can run from CI or a cron and page
 * someone. Spec §23 requires the legal audit record to be immutable; this is how
 * that claim is actually tested rather than merely asserted.
 *
 * What a failure means:
 *   row_modified        a row's stored content no longer matches its own hash
 *   row_count_mismatch  rows were inserted into or deleted from a sealed range
 *   root_mismatch       a sealed range's rows no longer produce its root
 *   seal_link_broken    a seal does not chain to its predecessor
 *   seal_gap            seals do not tile the sequence space contiguously
 *   unstamped_rows      rows outside the guarantee (chain stamping failed)
 *
 * None of these are recoverable by re-running: they mean the database was
 * written to outside the application. Investigate rather than re-seal.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const auditSeal = require('../src/service/auditSeal.service');

const args = process.argv.slice(2);
const fromSeq = args.includes('--from') ? Number(args[args.indexOf('--from') + 1]) || 0 : 0;
const alsoSeal = args.includes('--seal');

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(2);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  if (alsoSeal) {
    const result = await auditSeal.sealPending();
    console.log(
      result.sealed
        ? `Sealed ${result.sealed} pending rows (${result.fromSeq}–${result.toSeq})\n`
        : 'Nothing pending to seal\n'
    );
  }

  const started = Date.now();
  const { ok, checked, problems } = await auditSeal.verifyChain({ fromSeq });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`Verified ${checked} audit rows in ${elapsed}s`);

  if (ok) {
    console.log('\nChain intact — every sealed row matches its hash and every seal links correctly.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`\n${problems.length} problem(s) found:\n`);
  const byType = problems.reduce((acc, p) => {
    (acc[p.type] = acc[p.type] || []).push(p);
    return acc;
  }, {});

  for (const [type, items] of Object.entries(byType)) {
    console.log(`  ${type} (${items.length})`);
    for (const item of items.slice(0, 10)) {
      console.log(`    - ${item.detail}`);
    }
    if (items.length > 10) console.log(`    ... and ${items.length - 10} more`);
  }

  console.log('\nThe audit log was modified outside the application. Do not re-seal — investigate.');
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(async (err) => {
  console.error(`Verification failed to run: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
