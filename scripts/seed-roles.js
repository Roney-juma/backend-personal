/**
 * Seed / refresh RBAC roles.
 *
 *   node scripts/seed-roles.js            # global super-admin + default roles for EVERY company
 *   node scripts/seed-roles.js <companyId>  # just that company
 *
 * Idempotent: upserts each default role (by { company, name }) and sets its
 * permissions to the current template; refreshes the global Super Admin to hold
 * every permission. Existing custom roles are left untouched.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Role = require('../src/models/roles.model');
const InsuranceCompany = require('../src/models/insuranceCompany.model');
const { ALL_PERMISSIONS, DEFAULT_ROLES } = require('../src/constants/permissions');

const SUPER_ADMIN = 'Super Admin';

async function upsertRole(name, company, permissions) {
  await Role.findOneAndUpdate(
    { name, company: company ?? null },
    { $set: { permissions }, $setOnInsert: { name, company: company ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  console.log(`  ✓ ${name}${company ? '' : ' (global)'} — ${permissions.length} permissions`);
}

async function seedCompany(company) {
  console.log(`Company ${company?._id || 'GLOBAL'}${company ? ` (${company.companyName})` : ''}:`);
  for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
    await upsertRole(name, company?._id, perms);
  }
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('MONGO_URI not set');
  await mongoose.connect(uri);
  console.log('Connected.\n');

  // Global super-admin always holds every permission.
  await upsertRole(SUPER_ADMIN, null, ALL_PERMISSIONS);
  console.log('');

  const arg = process.argv[2];
  const companies = arg
    ? [await InsuranceCompany.findById(arg)]
    : await InsuranceCompany.find({});
  for (const c of companies.filter(Boolean)) {
    await seedCompany(c);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
