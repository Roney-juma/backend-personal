#!/usr/bin/env node
// Seed a test insurance company + 2 portal users for manual testing.
// Models-only (no service layer) so it runs without Redis/SMTP side effects;
// mirrors insuranceCompany.service.createCompany + users.service.createUser.
//
//   node scripts/seed-test-company.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const InsuranceCompany = require('../src/models/insuranceCompany.model');
const Users = require('../src/models/users.model');
const Role = require('../src/models/roles.model');
const permissionsCatalog = require('../src/role-permissions.json');

const COMPANY = {
  companyName: 'Sunrise Test Insurance',
  registrationNumber: 'TEST-2026-001',
  email: 'stankaranja1+sunrise@gmail.com',
  password: 'SunTest@2026',
  phone: '+254700000001',
  address: { street: 'Test Lane 1', city: 'Nairobi', country: 'Kenya' },
  website: 'https://example.com',
  notes: 'Seeded test company — safe to delete',
};

const ADMIN = {
  username: 'sunrise.admin',
  fullName: 'Sunrise Super Admin',
  email: 'stankaranja1+sunrise.admin@gmail.com',
};

const OFFICER = {
  username: 'sunrise.claims',
  fullName: 'Sunrise Claims Officer',
  email: 'stankaranja1+sunrise.claims@gmail.com',
  password: 'ClaimsTest@2026',
};

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected');

  // Company (active so it shows in the portal and /public/companies)
  let company = await InsuranceCompany.findOne({
    $or: [{ email: COMPANY.email }, { registrationNumber: COMPANY.registrationNumber }],
  });
  if (company) {
    console.log(`company exists: ${company._id}`);
  } else {
    company = await InsuranceCompany.create({
      ...COMPANY,
      password: await bcrypt.hash(COMPANY.password, 10),
      contactPerson: { username: ADMIN.username, fullName: ADMIN.fullName, email: ADMIN.email },
      status: 'active',
      onboardedAt: new Date(),
    });
    console.log(`company created: ${company._id}`);
  }
  if (company.status !== 'active') {
    company.status = 'active';
    await company.save();
    console.log('company status -> active');
  }

  // Global Super Admin role (same shape ensureSuperAdminRole seeds)
  const allPerms = Object.values(permissionsCatalog.permissions || {}).flat();
  const superAdminRole = await Role.findOneAndUpdate(
    { name: 'Super Admin', company: null },
    { $setOnInsert: { name: 'Super Admin', company: null, permissions: allPerms } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`super admin role: ${superAdminRole._id}`);

  // Company-scoped role with portal-recognised permissions
  const claimsRole = await Role.findOneAndUpdate(
    { name: 'Claims Officer', company: company._id },
    { $setOnInsert: { name: 'Claims Officer', company: company._id, permissions: ['MANAGE_CLAIMS', 'MANAGE_CUSTOMERS', 'REPORTS'] } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`claims officer role: ${claimsRole._id}`);

  const ensureUser = async (spec, role, password) => {
    let user = await Users.findOne({ email: spec.email });
    if (user) {
      console.log(`user exists: ${spec.email}`);
      return user;
    }
    user = await Users.create({
      company: company._id,
      username: spec.username,
      fullName: spec.fullName,
      email: spec.email,
      password: await bcrypt.hash(password, 10),
      role: role._id,
      active: true,
      mustChangePassword: true,
    });
    console.log(`user created: ${spec.email}`);
    return user;
  };

  await ensureUser(ADMIN, superAdminRole, COMPANY.password);
  await ensureUser(OFFICER, claimsRole, OFFICER.password);

  console.log('\n=== SUMMARY ===');
  console.log(`Company: ${COMPANY.companyName} (${company._id}) status=active`);
  console.log(`User 1 (Super Admin):    ${ADMIN.email}  /  ${COMPANY.password}`);
  console.log(`User 2 (Claims Officer): ${OFFICER.email}  /  ${OFFICER.password}`);
  console.log('Both users must change password on first portal login.');

  await mongoose.disconnect();
  process.exit(0);
};

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
