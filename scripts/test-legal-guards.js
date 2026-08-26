/**
 * Verify the Phase 0 correctness guards actually bite.
 *
 *   node scripts/test-legal-guards.js
 *
 * Checks the append-only plugin, the audit hash function and the ledger's input
 * validation. No database required — the append-only guards are Mongoose
 * middleware, so they can be exercised against an unconnected model.
 *
 * These guards exist because the ledger and the audit log are the two places
 * where a silent write would destroy the module's credibility rather than just
 * produce a bug.
 */

const mongoose = require('mongoose');
const { contentHashOf, canonicalize } = require('../src/models/plugins/hashChain');
const { LEDGER_ENTRY_TYPES } = require('../src/constants/legal.constants');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function rejects(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  console.log('\n1. Append-only guards');
  {
    const LegalLedgerEntry = require('../src/models/legalLedgerEntry.model');
    const AuditLog = require('../src/models/audit.model');

    check(
      'ledger updateOne is blocked',
      await rejects(() => LegalLedgerEntry.updateOne({ _id: new mongoose.Types.ObjectId() }, { amountMinor: 1 }))
    );
    check(
      'ledger updateMany is blocked',
      await rejects(() => LegalLedgerEntry.updateMany({}, { amountMinor: 1 }))
    );
    check(
      'ledger findOneAndUpdate is blocked',
      await rejects(() => LegalLedgerEntry.findOneAndUpdate({}, { amountMinor: 1 }))
    );
    check(
      'ledger deleteOne is blocked',
      await rejects(() => LegalLedgerEntry.deleteOne({ _id: new mongoose.Types.ObjectId() }))
    );
    check(
      'ledger deleteMany is blocked',
      await rejects(() => LegalLedgerEntry.deleteMany({}))
    );
    check(
      'audit log updateOne is blocked',
      await rejects(() => AuditLog.updateOne({}, { action: 'TAMPERED' }))
    );
    check(
      'audit log deleteMany is blocked',
      await rejects(() => AuditLog.deleteMany({}))
    );

    // Re-saving an existing document is the subtlest mutation path — it looks
    // like an ordinary save but rewrites history in place.
    const entry = new LegalLedgerEntry({
      company: new mongoose.Types.ObjectId(),
      claim: new mongoose.Types.ObjectId(),
      entryType: 'legal_fee',
      direction: 'debit',
      amountMinor: 100,
      occurredAt: new Date(),
    });
    entry.isNew = false;
    check('re-saving an existing ledger entry is blocked', await rejects(() => entry.save()));
  }

  console.log('\n2. The maintenance escape hatch');
  {
    const AuditLog = require('../src/models/audit.model');

    // The sealer stamps sealId onto audit rows it has covered. Without an escape
    // hatch the guard would block its own housekeeping — but it has to be
    // explicit, so that an ordinary write can never take this path by accident.
    // The guard reads `this.getOptions().allowMutation`; verify that is exactly
    // what a query built with the flag carries.
    const query = AuditLog.updateMany({}, { $set: { sealId: null } }, { allowMutation: true });
    check('a query built with allowMutation exposes it to the guard', query.getOptions().allowMutation === true);

    const plain = AuditLog.updateMany({}, { $set: { sealId: null } });
    check('an ordinary query does not carry the flag', !plain.getOptions().allowMutation);

    // And confirm the rejection is the guard's, not some unrelated failure.
    let message = '';
    try {
      await AuditLog.updateOne({}, { $set: { action: 'TAMPERED' } });
    } catch (err) {
      message = err.message;
    }
    check(
      'the rejection comes from the append-only guard',
      /append-only/i.test(message),
      `got: ${message}`
    );
  }

  console.log('\n3. Audit content hashing');
  {
    const row = {
      action: 'UPDATE',
      module: 'Legal',
      resourceId: '507f1f77bcf86cd799439011',
      statusCode: 200,
      success: true,
    };

    const h1 = contentHashOf(row);
    const h2 = contentHashOf({ ...row });
    check('the same content hashes identically', h1 === h2);

    // Key order must not matter, or a re-serialised document would look tampered.
    const reordered = { success: true, statusCode: 200, resourceId: row.resourceId, module: 'Legal', action: 'UPDATE' };
    check('key order does not change the hash', contentHashOf(reordered) === h1);

    check(
      'changing any field changes the hash',
      contentHashOf({ ...row, action: 'DELETE' }) !== h1
    );
    check(
      'changing a nested value changes the hash',
      contentHashOf({ ...row, changes: { old: 1 } }) !== contentHashOf({ ...row, changes: { old: 2 } })
    );

    // Bookkeeping fields are excluded, so stamping sealId cannot invalidate a hash.
    check(
      'stamping sealId does not change the hash',
      contentHashOf({ ...row, sealId: 'abc', seq: 5, contentHash: h1 }) === h1
    );

    check('canonicalize is deterministic', canonicalize({ b: 1, a: [2, 3] }) === canonicalize({ a: [2, 3], b: 1 }));
    check('null and undefined canonicalize the same', canonicalize(null) === canonicalize(undefined));
  }

  console.log('\n4. Ledger input validation');
  {
    const ledger = require('../src/service/legalLedger.service');
    const company = new mongoose.Types.ObjectId();
    const claim = new mongoose.Types.ObjectId();

    check(
      'an unknown entry type is rejected',
      await rejects(() => ledger.post({ company, claim, entryType: 'bribe', amountMinor: 100 }))
    );
    check(
      'a float amount is rejected',
      await rejects(() => ledger.post({ company, claim, entryType: 'legal_fee', amountMinor: 100.5 }))
    );
    check(
      'a zero amount is rejected',
      await rejects(() => ledger.post({ company, claim, entryType: 'legal_fee', amountMinor: 0 }))
    );
    check(
      'a negative non-signed amount is rejected',
      await rejects(() => ledger.post({ company, claim, entryType: 'legal_fee', amountMinor: -100 }))
    );
    check(
      'a reserve entry without a bucket is rejected',
      await rejects(() => ledger.post({ company, claim, entryType: 'reserve_set', amountMinor: 100 }))
    );
    check(
      'an entry without a claim is rejected',
      await rejects(() => ledger.post({ company, entryType: 'legal_fee', amountMinor: 100 }))
    );
    check(
      'a reversal without a reason is rejected',
      await rejects(() => ledger.reverse(new mongoose.Types.ObjectId(), ''))
    );
    check(
      'an empty ledger scope is rejected',
      await rejects(async () => ledger.entries({}))
    );
  }

  console.log('\n5. Entry-type table integrity');
  {
    const types = Object.entries(LEDGER_ENTRY_TYPES);
    check(
      'every entry type declares a direction',
      types.every(([, s]) => s.direction === 'debit' || s.direction === 'credit')
    );
    check(
      'every entry type declares reserve and signed flags',
      types.every(([, s]) => typeof s.reserve === 'boolean' && typeof s.signed === 'boolean')
    );
    check(
      'only reserve types are marked as reserves',
      types.filter(([, s]) => s.reserve).every(([t]) => t.startsWith('reserve_'))
    );
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
