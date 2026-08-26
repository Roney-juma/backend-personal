/**
 * RBAC readiness audit — who would start being denied if RBAC_ENFORCED went true?
 *
 *   node scripts/audit-rbac-readiness.js              # every tenant
 *   node scripts/audit-rbac-readiness.js <companyId>  # one tenant
 *
 * STRICTLY READ-ONLY. It opens no writes, creates nothing and changes nothing.
 *
 * Why this exists: RBAC_ENFORCED is platform-wide. While it is unset, a failing
 * permission check is logged and the request PROCEEDS. Turning it on makes every
 * one of those checks actually deny — across claims, customers, garages,
 * suppliers and the rest, not just Legal. Any user whose role is missing a
 * permission it currently relies on starts getting 403s the moment it flips,
 * with no warning and no gradual rollout.
 *
 * So this reports, before the flip:
 *   - users with no role at all (they will be denied everything)
 *   - roles holding no permissions
 *   - roles referencing permissions that no longer exist in the catalog
 *   - which default-role permissions each tenant's roles are missing
 *   - whether the Legal roles have been seeded for tenants adopting the module
 *
 * A clean run means the flip is safe. Anything under "WOULD BE DENIED" is a
 * person who loses access on the day.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const User = require('../src/models/users.model');
const Role = require('../src/models/roles.model');
const InsuranceCompany = require('../src/models/insuranceCompany.model');
const { ALL_PERMISSIONS, DEFAULT_ROLES, ADMIN_ROLE_NAMES } = require('../src/constants/permissions');

const targetCompany = process.argv.find((a) => !a.startsWith('-') && /^[0-9a-f]{24}$/i.test(a));

const LEGAL_ROLES = [
  'Third-Party Claims Officer', 'Legal Officer', 'Senior Legal Officer',
  'Head of Legal', 'Head of Claims', 'General Manager', 'CEO', 'Auditor',
];

const isAdminRole = (name) =>
  ADMIN_ROLE_NAMES.has(String(name || '').toLowerCase().replace(/[\s_-]/g, ''));

const pad = (s, n) => String(s ?? '').padEnd(n);

async function run() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('MONGO_URI is not set');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name;
  console.log(`Connected to ${dbName} — READ ONLY, nothing will be written.\n`);

  const catalog = new Set(ALL_PERMISSIONS);
  const companies = targetCompany
    ? await InsuranceCompany.find({ _id: targetCompany }).lean()
    : await InsuranceCompany.find({}).lean();

  const findings = { noRole: [], emptyRole: [], staleP: [], missingLegal: [] };
  let totalUsers = 0;
  let safeUsers = 0;

  // ── Global: roles with no company (platform-level) ─────────────────────────
  const allRoles = await Role.find({}).lean();
  const rolesById = Object.fromEntries(allRoles.map((r) => [String(r._id), r]));

  for (const role of allRoles) {
    const perms = role.permissions || [];
    if (!isAdminRole(role.name) && perms.length === 0) {
      findings.emptyRole.push({ role: role.name, company: role.company });
    }
    const stale = perms.filter((p) => !catalog.has(p));
    if (stale.length) {
      findings.staleP.push({ role: role.name, company: role.company, stale });
    }
  }

  // ── Per tenant ─────────────────────────────────────────────────────────────
  console.log('='.repeat(78));
  console.log('PER-TENANT READINESS');
  console.log('='.repeat(78));

  for (const company of companies) {
    const name = company.companyName || company.name || String(company._id);
    const users = await User.find({ company: company._id, active: true })
      .select('fullName email role')
      .populate('role', 'name permissions')
      .lean();

    totalUsers += users.length;

    const roleNames = new Set(
      allRoles.filter((r) => String(r.company) === String(company._id)).map((r) => r.name)
    );

    const denied = users.filter((u) => !u.role || !(u.role.permissions || []).length);
    denied.forEach((u) =>
      findings.noRole.push({
        user: u.fullName || u.email,
        email: u.email,
        company: name,
        reason: !u.role ? 'no role assigned' : `role "${u.role.name}" holds no permissions`,
      })
    );
    safeUsers += users.length - denied.length;

    const missingLegal = LEGAL_ROLES.filter((r) => !roleNames.has(r));
    if (missingLegal.length) findings.missingLegal.push({ company: name, missing: missingLegal });

    console.log(`\n${name}`);
    console.log(`  active users:        ${users.length}`);
    console.log(`  would be denied:     ${denied.length ? `${denied.length}  <-- ATTENTION` : '0'}`);
    console.log(`  roles configured:    ${roleNames.size}`);
    console.log(
      `  legal roles seeded:  ${LEGAL_ROLES.length - missingLegal.length}/${LEGAL_ROLES.length}` +
      (missingLegal.length ? `  (missing: ${missingLegal.join(', ')})` : '')
    );

    // Which permissions each role is missing against the current template.
    for (const role of allRoles.filter((r) => String(r.company) === String(company._id))) {
      if (isAdminRole(role.name)) continue;
      const template = DEFAULT_ROLES[role.name];
      if (!template) continue;
      const held = new Set(role.permissions || []);
      const missing = template.filter((p) => !held.has(p));
      if (missing.length) {
        console.log(
          `    · ${pad(role.name, 26)} missing ${missing.length} template permission(s)` +
          (missing.length <= 6 ? `: ${missing.join(', ')}` : `, incl. ${missing.slice(0, 4).join(', ')}…`)
        );
      }
    }
  }

  // ── Findings ───────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(78)}`);
  console.log('WOULD BE DENIED ON THE DAY');
  console.log('='.repeat(78));

  if (!findings.noRole.length) {
    console.log('\n  None. Every active user holds a role with at least one permission.');
  } else {
    console.log(`\n  ${findings.noRole.length} active user(s) would lose access immediately:\n`);
    for (const f of findings.noRole.slice(0, 40)) {
      console.log(`  · ${pad(f.user, 28)} ${pad(f.company, 24)} ${f.reason}`);
    }
    if (findings.noRole.length > 40) console.log(`  … and ${findings.noRole.length - 40} more`);
  }

  if (findings.emptyRole.length) {
    console.log(`\n  ${findings.emptyRole.length} role(s) hold no permissions at all:`);
    findings.emptyRole.slice(0, 20).forEach((f) => console.log(`  · ${f.role}`));
  }

  if (findings.staleP.length) {
    console.log(`\n  ${findings.staleP.length} role(s) reference permissions not in the catalog:`);
    findings.staleP.slice(0, 20).forEach((f) =>
      console.log(`  · ${pad(f.role, 26)} ${f.stale.join(', ')}`)
    );
    console.log('    (these are ignored at check time — harmless, but worth cleaning up)');
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(78)}`);
  const blocking = findings.noRole.length + findings.emptyRole.length;

  console.log(`Users checked: ${totalUsers}   ·   Would keep access: ${safeUsers}   ·   Would be denied: ${findings.noRole.length}`);
  console.log('');

  if (blocking === 0) {
    console.log('VERDICT: safe to set RBAC_ENFORCED=true.');
    console.log('         No active user loses access, and every role holds permissions.');
  } else {
    console.log('VERDICT: DO NOT flip RBAC_ENFORCED yet.');
    console.log(`         ${findings.noRole.length} user(s) would be denied on the day.`);
    console.log('         Fix by assigning roles, or run: node scripts/seed-roles.js');
  }

  if (findings.missingLegal.length) {
    console.log('');
    console.log('Legal roles are not yet seeded for some tenants. Run scripts/seed-roles.js');
    console.log('before those tenants use the module — it is idempotent and additive.');
  }

  console.log('');
  console.log('This audit wrote nothing.');
}

run()
  .catch((err) => {
    console.error(`\nAudit failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
