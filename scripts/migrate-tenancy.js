#!/usr/bin/env node
/**
 * Multi-tenancy backfill: stamp an InsuranceCompany onto legacy data.
 *
 * Idempotent — every step only touches documents that still lack the tenant
 * field, so re-running is a no-op. All reads/writes go through Model.collection
 * (the raw MongoDB driver), which bypasses the softDelete plugin's query
 * middleware and schema hooks, so soft-deleted documents are backfilled too.
 *
 * USAGE:
 *   node scripts/migrate-tenancy.js --default-company <companyId> [--dry-run]
 *
 * - --default-company <id>  InsuranceCompany to assign legacy/unmatched data to
 *                           (the current single insurer). Required for the
 *                           assignment steps (customers, claims, actors, AI).
 * - --dry-run               Report what WOULD change; writes nothing.
 *
 * Steps:
 *   1. roles       drop legacy unique index name_1; ensure compound index;
 *                  company: null on roles missing the field (null = global)
 *   2. customers   match free-text Insurer -> InsuranceCompany.companyName,
 *                  else default company
 *   3. claims      company from their customer's company, else default
 *   4. garages / assessors / suppliers / investigators -> default company
 *   5. claimtypes  company: null (global) where the field is missing
 *   6. aiusages / aianalyses  company from the linked claim, else default
 *   7. users       REPORT (no writes) insurer-portal admins without a company
 *   8. customers   auth-era backfill: drop legacy unique indexes (email_1,
 *                  policyNumber_1, username_1) for per-tenant compounds;
 *                  lowercase emails; grandfather legacy accounts as
 *                  active/self; mirror primary policy into policies[]
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Role = require('../src/models/roles.model');
const Customer = require('../src/models/customerModel');
const Claim = require('../src/models/claim.model');
const Garage = require('../src/models/garage.model');
const Assessor = require('../src/models/assessor.model');
const Supplier = require('../src/models/supplier.model');
const Investigator = require('../src/models/investigator.model');
const ClaimType = require('../src/models/claimType.model');
const AiUsage = require('../src/models/aiUsage.model');
const AiAnalysis = require('../src/models/aiAnalysis.model');
const InsuranceCompany = require('../src/models/insuranceCompany.model');
const Users = require('../src/models/users.model');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dcIdx = args.indexOf('--default-company');
const defaultCompanyArg = dcIdx !== -1 ? args[dcIdx + 1] : null;

const BATCH = 500;
// Matches docs where the tenant field was never set. Deliberately excludes
// explicit nulls for roles/claimtypes (null = global there); actor/data steps
// use MISSING_OR_NULL because a null tenant there just means "legacy".
const missing = (field) => ({ [field]: { $exists: false } });
const missingOrNull = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }] });

const summary = [];
const note = (step, detail, count) => {
  summary.push({ step, detail, count });
  console.log(`  ${detail}: ${count}`);
};

const updateWhereMissing = async (Model, filter, update, step, detail) => {
  const coll = Model.collection;
  if (dryRun) {
    note(step, `${detail} (would update)`, await coll.countDocuments(filter));
    return;
  }
  const res = await coll.updateMany(filter, update);
  note(step, `${detail} (updated)`, res.modifiedCount);
};

// ── Step 1: roles ───────────────────────────────────────────────────────────
const migrateRoles = async () => {
  console.log('\n[1/8] Roles');
  const indexes = await Role.collection.indexes();
  const legacy = indexes.find((ix) => ix.name === 'name_1');
  if (legacy) {
    if (dryRun) {
      console.log('  would drop legacy index name_1');
      summary.push({ step: 'roles', detail: 'legacy index name_1 (would drop)', count: 1 });
    } else {
      await Role.collection.dropIndex('name_1');
      console.log('  dropped legacy index name_1');
      summary.push({ step: 'roles', detail: 'legacy index name_1 dropped', count: 1 });
    }
  } else {
    console.log('  legacy index name_1 not present (ok)');
    summary.push({ step: 'roles', detail: 'legacy index name_1 (already gone)', count: 0 });
  }
  if (!dryRun) {
    // Creates { company: 1, name: 1 } unique from the schema; never drops others.
    await Role.createIndexes();
    console.log('  ensured compound index { company: 1, name: 1 }');
  }
  await updateWhereMissing(Role, missing('company'), { $set: { company: null } }, 'roles', 'roles set to global (company: null)');
};

// ── Step 2: customers ───────────────────────────────────────────────────────
const migrateCustomers = async (defaultCompanyId) => {
  console.log('\n[2/8] Customers');
  const companies = await InsuranceCompany.collection
    .find({}, { projection: { companyName: 1 } })
    .toArray();
  const byName = new Map(
    companies
      .filter((c) => typeof c.companyName === 'string')
      .map((c) => [c.companyName.trim().toLowerCase(), c._id])
  );

  let matchedByName = 0;
  let defaulted = 0;
  let ops = [];
  const flush = async () => {
    if (ops.length && !dryRun) await Customer.collection.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  const cursor = Customer.collection.find(missingOrNull('company'), { projection: { Insurer: 1 } });
  for await (const doc of cursor) {
    const key = typeof doc.Insurer === 'string' ? doc.Insurer.trim().toLowerCase() : '';
    const match = key ? byName.get(key) : undefined;
    if (match) matchedByName += 1; else defaulted += 1;
    ops.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { company: match || defaultCompanyId } } },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  const verb = dryRun ? 'would set' : 'set';
  note('customers', `matched by Insurer name (${verb})`, matchedByName);
  note('customers', `defaulted (${verb})`, defaulted);
};

// ── Step 3: claims ──────────────────────────────────────────────────────────
const migrateClaims = async (defaultCompanyId) => {
  console.log('\n[3/8] Claims');
  // customerId -> company map, streamed so we never hold full customer docs.
  const customerCompany = new Map();
  const custCursor = Customer.collection.find({}, { projection: { company: 1 } });
  for await (const c of custCursor) {
    if (c.company) customerCompany.set(String(c._id), c.company);
  }

  let fromCustomer = 0;
  let defaulted = 0;
  let ops = [];
  const flush = async () => {
    if (ops.length && !dryRun) await Claim.collection.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  const cursor = Claim.collection.find(missingOrNull('company'), { projection: { customerId: 1 } });
  for await (const doc of cursor) {
    const company = doc.customerId && customerCompany.get(String(doc.customerId));
    if (company) fromCustomer += 1; else defaulted += 1;
    ops.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { company: company || defaultCompanyId } } },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  const verb = dryRun ? 'would set' : 'set';
  note('claims', `from customer company (${verb})`, fromCustomer);
  note('claims', `defaulted — customer missing/unstamped (${verb})`, defaulted);
};

// ── Step 4: garages / assessors / suppliers / investigators ─────────────────
const migrateActors = async (defaultCompanyId) => {
  console.log('\n[4/8] Garages / Assessors / Suppliers / Investigators');
  await updateWhereMissing(Garage, missingOrNull('company'), { $set: { company: defaultCompanyId } }, 'garages', 'garages defaulted');
  await updateWhereMissing(Assessor, missingOrNull('company'), { $set: { company: defaultCompanyId } }, 'assessors', 'assessors defaulted');
  await updateWhereMissing(Supplier, missingOrNull('insuranceCompany'), { $set: { insuranceCompany: defaultCompanyId } }, 'suppliers', 'suppliers defaulted');
  await updateWhereMissing(Investigator, missingOrNull('company'), { $set: { company: defaultCompanyId } }, 'investigators', 'investigators defaulted');
};

// ── Step 5: claim types ─────────────────────────────────────────────────────
const migrateClaimTypes = async () => {
  console.log('\n[5/8] Claim types');
  // Same index swap as roles: name was globally unique, now unique per tenant.
  const indexes = await ClaimType.collection.indexes();
  const legacy = indexes.find((ix) => ix.name === 'name_1');
  if (legacy) {
    if (dryRun) {
      console.log('  would drop legacy index name_1');
      summary.push({ step: 'claimtypes', detail: 'legacy index name_1 (would drop)', count: 1 });
    } else {
      await ClaimType.collection.dropIndex('name_1');
      console.log('  dropped legacy index name_1');
      summary.push({ step: 'claimtypes', detail: 'legacy index name_1 dropped', count: 1 });
    }
  } else {
    console.log('  legacy index name_1 not present (ok)');
    summary.push({ step: 'claimtypes', detail: 'legacy index name_1 (already gone)', count: 0 });
  }
  if (!dryRun) {
    await ClaimType.createIndexes();
    console.log('  ensured compound index { company: 1, name: 1 }');
  }
  // Existing claim types stay global — visible to every tenant.
  await updateWhereMissing(ClaimType, missing('company'), { $set: { company: null } }, 'claimtypes', 'claim types set to global (company: null)');
};

// ── Step 6: AI usage / analyses ─────────────────────────────────────────────
const migrateAiCollection = async (Model, label, defaultCompanyId) => {
  let fromClaim = 0;
  let defaulted = 0;
  let batch = [];

  const resolveBatch = async () => {
    if (!batch.length) return;
    const claimIds = [...new Set(batch.filter((d) => d.claimId).map((d) => String(d.claimId)))]
      .map((id) => new mongoose.Types.ObjectId(id));
    const claims = claimIds.length
      ? await Claim.collection.find({ _id: { $in: claimIds } }, { projection: { company: 1 } }).toArray()
      : [];
    const claimCompany = new Map(claims.filter((c) => c.company).map((c) => [String(c._id), c.company]));

    const ops = batch.map((doc) => {
      const company = doc.claimId && claimCompany.get(String(doc.claimId));
      if (company) fromClaim += 1; else defaulted += 1;
      return {
        updateOne: { filter: { _id: doc._id }, update: { $set: { company: company || defaultCompanyId } } },
      };
    });
    if (!dryRun) await Model.collection.bulkWrite(ops, { ordered: false });
    batch = [];
  };

  const cursor = Model.collection.find(missingOrNull('company'), { projection: { claimId: 1 } });
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH) await resolveBatch();
  }
  await resolveBatch();

  const verb = dryRun ? 'would set' : 'set';
  note(label, `from linked claim (${verb})`, fromClaim);
  note(label, `defaulted — no resolvable claim (${verb})`, defaulted);
};

const migrateAi = async (defaultCompanyId) => {
  console.log('\n[6/8] AI usage / analyses');
  await migrateAiCollection(AiUsage, 'aiusages', defaultCompanyId);
  await migrateAiCollection(AiAnalysis, 'aianalyses', defaultCompanyId);
};

// ── Step 7: users (report only) ─────────────────────────────────────────────
// ── Step 8: customer auth-era backfill (activation/import model) ────────────
const migrateCustomerAuth = async () => {
  console.log('\n[8/8] Customers — auth/lifecycle backfill');

  // Legacy GLOBAL unique indexes → per-tenant compound indexes (schema defines
  // the new ones). username_1 goes without replacement (username is vestigial).
  const indexes = await Customer.collection.indexes();
  for (const legacyName of ['email_1', 'policyNumber_1', 'username_1']) {
    const legacy = indexes.find((ix) => ix.name === legacyName);
    if (legacy) {
      if (dryRun) {
        console.log(`  would drop legacy index ${legacyName}`);
        summary.push({ step: 'customers-auth', detail: `legacy index ${legacyName} (would drop)`, count: 1 });
      } else {
        await Customer.collection.dropIndex(legacyName);
        console.log(`  dropped legacy index ${legacyName}`);
        summary.push({ step: 'customers-auth', detail: `legacy index ${legacyName} dropped`, count: 1 });
      }
    } else {
      console.log(`  legacy index ${legacyName} not present (ok)`);
    }
  }
  if (!dryRun) {
    await Customer.createIndexes();
    console.log('  ensured per-tenant indexes on { company, policyNumber } / { company, email }');
  }

  // The schema now lowercases emails on write AND on query filters — stored
  // mixed-case emails would silently stop matching logins, so normalize.
  const mixedCase = { email: { $type: 'string', $regex: /[A-Z]/ } };
  if (dryRun) {
    note('customers-auth', 'emails to lowercase (would update)', await Customer.collection.countDocuments(mixedCase));
  } else {
    const res = await Customer.collection.updateMany(mixedCase, [
      { $set: { email: { $toLower: '$email' } } },
    ]);
    note('customers-auth', 'emails lowercased', res.modifiedCount);
  }

  // Grandfather pre-existing accounts: they hold a password and logged in by
  // email, so they are active/self and skip the activation flow entirely.
  await updateWhereMissing(
    Customer,
    { status: { $exists: false } },
    { $set: { status: 'active', source: 'self', emailVerified: true } },
    'customers-auth',
    'legacy customers marked active/self'
  );

  // Mirror the top-level primary policy into policies[] where absent.
  const noPolicies = {
    policyNumber: { $type: 'string' },
    $or: [{ policies: { $exists: false } }, { policies: { $size: 0 } }],
  };
  if (dryRun) {
    note('customers-auth', 'policies[] to backfill (would update)', await Customer.collection.countDocuments(noPolicies));
  } else {
    const res = await Customer.collection.updateMany(noPolicies, [
      {
        $set: {
          policies: [{
            policyNumber: '$policyNumber',
            policyType: '$policyType',
            status: 'active',
          }],
        },
      },
    ]);
    note('customers-auth', 'policies[] backfilled from primary policy', res.modifiedCount);
  }
};

// ── Step 9: support tickets mis-stamped with a user id as company ───────────
// The company support routes previously set company = req.user.id, which for
// insurer-portal admins is the USER id, not the company. Re-stamp those from
// the user's company; report anything unresolvable.
const repairSupportTickets = async (defaultCompanyId) => {
  console.log('\n[9/9] Support tickets — repair company refs');
  const SupportTicket = require('../src/models/supportTicket.model');

  const companyIds = new Set(
    (await InsuranceCompany.collection.find({}, { projection: { _id: 1 } }).toArray())
      .map((c) => String(c._id))
  );

  let repaired = 0;
  let defaulted = 0;
  let unresolvable = 0;
  const cursor = SupportTicket.collection.find({}, { projection: { company: 1, ticketNumber: 1 } });
  for await (const t of cursor) {
    if (!t.company || companyIds.has(String(t.company))) continue;
    const user = await Users.collection.findOne(
      { _id: t.company },
      { projection: { company: 1 } }
    );
    const target = user?.company || defaultCompanyId;
    if (target) {
      if (!dryRun) {
        await SupportTicket.collection.updateOne(
          { _id: t._id },
          { $set: { company: target } }
        );
      }
      if (user?.company) repaired += 1; else defaulted += 1;
    } else {
      unresolvable += 1;
      console.log(`    unresolvable ticket ${t.ticketNumber || t._id}: company ${t.company} is neither a company nor a known user`);
    }
  }
  const verb = dryRun ? 'would repair' : 'repaired';
  note('support', `tickets re-stamped from creator's company (${verb})`, repaired);
  note('support', `orphaned tickets assigned to default company (${verb})`, defaulted);
  note('support', 'tickets with unresolvable company (manual review)', unresolvable);
};

const reportUsers = async () => {
  console.log('\n[7/8] Users (report only — no writes)');
  const orphans = await Users.collection
    .find(missingOrNull('company'), { projection: { email: 1, username: 1, accountType: 1 } })
    .limit(50)
    .toArray();
  const count = await Users.collection.countDocuments(missingOrNull('company'));
  note('users', 'users without a company (manual review needed)', count);
  for (const u of orphans) {
    console.log(`    - ${u._id} ${u.email || u.username || ''} (${u.accountType || 'unknown'})`);
  }
  if (count > orphans.length) console.log(`    ... and ${count - orphans.length} more`);
};

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error('ERROR: MONGO_URI is not set');
    process.exit(1);
  }
  if (dcIdx !== -1 && (!defaultCompanyArg || defaultCompanyArg.startsWith('--'))) {
    console.error('ERROR: --default-company requires a company id');
    process.exit(1);
  }
  if (defaultCompanyArg && !mongoose.Types.ObjectId.isValid(defaultCompanyArg)) {
    console.error(`ERROR: "${defaultCompanyArg}" is not a valid ObjectId`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. ${dryRun ? 'DRY RUN — nothing will be written.' : 'LIVE RUN.'}`);

  try {
    let defaultCompanyId = null;
    if (defaultCompanyArg) {
      defaultCompanyId = new mongoose.Types.ObjectId(defaultCompanyArg);
      const company = await InsuranceCompany.collection.findOne({ _id: defaultCompanyId });
      if (!company) {
        console.error(`ERROR: InsuranceCompany ${defaultCompanyArg} not found`);
        process.exit(1);
      }
      console.log(`Default company: ${company.companyName} (${defaultCompanyId})`);
    }

    await migrateRoles();

    if (defaultCompanyId) {
      await migrateCustomers(defaultCompanyId);
      await migrateClaims(defaultCompanyId);
      await migrateActors(defaultCompanyId);
    } else {
      console.log('\n[2-4/8] SKIPPED (customers, claims, actors) — pass --default-company <id> to run the assignment steps.');
    }

    await migrateClaimTypes();

    if (defaultCompanyId) {
      await migrateAi(defaultCompanyId);
    } else {
      console.log('\n[6/8] SKIPPED (AI usage/analyses) — pass --default-company <id>.');
    }

    await reportUsers();

    await migrateCustomerAuth();

    await repairSupportTickets(defaultCompanyId);

    console.log(`\n=== Summary${dryRun ? ' (dry run — no writes performed)' : ''} ===`);
    console.table(summary);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error(`Migration failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
