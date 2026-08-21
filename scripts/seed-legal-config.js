/**
 * Seed / refresh per-tenant Legal module configuration.
 *
 *   node scripts/seed-legal-config.js              # every company
 *   node scripts/seed-legal-config.js <companyId>  # just that one
 *   node scripts/seed-legal-config.js --report     # show what is configured, change nothing
 *
 * Idempotent and NON-DESTRUCTIVE: a company that already has a config keeps it
 * untouched, including any edits they have made. Only missing configs are
 * created, from the defaults in src/constants/legal.constants.js.
 *
 * Roles are seeded separately by scripts/seed-roles.js, which already reads the
 * Legal roles from the shared DEFAULT_ROLES template.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const LegalConfig = require('../src/models/legalConfig.model');
const InsuranceCompany = require('../src/models/insuranceCompany.model');
const legalConfigService = require('../src/service/legalConfig.service');

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const targetId = args.find((a) => !a.startsWith('--'));

/**
 * Warn about the settings a tenant MUST supply before the module is usable.
 *
 * The reserving schedule ships with zero amounts on purpose: an insurer's
 * reserving policy is theirs, and silently reserving a number we invented would
 * be worse than reserving nothing. This surfaces that gap loudly rather than
 * letting it be discovered when the first reserve comes out at zero.
 */
function auditConfig(config, companyName) {
  const gaps = [];

  const unfilled = (config.reservingSchedule || []).filter(
    (b) => !b.defaultMinor && !b.minMinor && !b.maxMinor
  );
  if (unfilled.length) {
    gaps.push(
      `reserving schedule: ${unfilled.length}/${config.reservingSchedule.length} bands have no amounts ` +
      `(${unfilled.slice(0, 3).map((b) => b.code).join(', ')}${unfilled.length > 3 ? ', …' : ''})`
    );
  }

  if (!config.referralTriggers?.length) {
    gaps.push('referral triggers: none enabled — nothing will auto-refer to Legal');
  }

  const periods = config.limitationPeriods instanceof Map
    ? Object.fromEntries(config.limitationPeriods)
    : config.limitationPeriods || {};
  const periodSummary = Object.entries(periods)
    .map(([k, v]) => `${k}=${v}mo`)
    .join(', ');

  console.log(`  limitation periods: ${periodSummary || 'NONE'}`);
  console.log(`  authority bands:    ${config.authorityMatrix?.length || 0}`);
  console.log(`  escalation rungs:   ${(config.escalationChain || []).map((r) => r.role).join(' → ') || 'NONE'}`);
  console.log(`  auditors see privileged contents: ${config.auditorSeesPrivilegedContents ? 'YES' : 'no'}`);

  if (gaps.length) {
    console.log(`  ${'!'.repeat(3)} needs attention before go-live:`);
    for (const gap of gaps) console.log(`      - ${gap}`);
  }
  return gaps.length;
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('MONGO_URI not set');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const companies = targetId
    ? await InsuranceCompany.find({ _id: targetId }).lean()
    : await InsuranceCompany.find({}).lean();

  if (!companies.length) {
    console.log(targetId ? `No company found with id ${targetId}` : 'No companies found.');
    return;
  }

  let created = 0;
  let existing = 0;
  let needingAttention = 0;

  for (const company of companies) {
    const name = company.companyName || company.name || company._id;
    const had = await LegalConfig.findOne({ company: company._id }).lean();

    let config = had;
    if (!had && !reportOnly) {
      config = await legalConfigService.ensureForCompany(company._id);
      created += 1;
      console.log(`${name}: created`);
    } else if (had) {
      existing += 1;
      console.log(`${name}: exists (version ${had.version})`);
    } else {
      console.log(`${name}: MISSING (report mode — not created)`);
      continue;
    }

    if (auditConfig(config, name) > 0) needingAttention += 1;
    console.log('');
  }

  console.log('─'.repeat(60));
  console.log(
    `${companies.length} companies · ${created} created · ${existing} already configured · ` +
    `${needingAttention} need attention`
  );

  if (needingAttention) {
    console.log(
      '\nTenants above with gaps cannot reserve accurately until their reserving\n' +
      'schedule is loaded. Set it via PUT /legal/config or the Legal Administration screen.'
    );
  }
}

run()
  .catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
