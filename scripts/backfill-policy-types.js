/**
 * Seed the policy-type catalogue and bring existing records onto it.
 *
 * `policyType` was free text everywhere, so the same cover is sitting in the
 * database as "Comprehensive", "comprehensive", "COMP", "Comp.", "third party
 * only" and "T.P.O" depending on who typed it. The dropdown that replaces the
 * text box cannot show a value it does not recognise, so those records would
 * appear blank — and saving one would quietly discard the cover.
 *
 * This normalises them onto the catalogue names. Three properties matter:
 *
 *   1. SAFE BY DEFAULT. Dry run unless --commit is passed. Nothing is written
 *      while you are still deciding.
 *   2. CONSERVATIVE. Only values it is confident about are changed. Anything
 *      unrecognised is reported and left exactly as it is — a wrong cover on a
 *      motor policy is worse than an untidy one, because it decides whether the
 *      insured's own car is covered at all.
 *   3. REVERSIBLE. Every change is written to a tagged journal collection
 *      before it is applied, so --undo puts back precisely what was there and
 *      nothing else. It does not guess, and it will not touch a value that has
 *      been edited since the run.
 *
 *   node scripts/backfill-policy-types.js               # dry run, changes nothing
 *   node scripts/backfill-policy-types.js --commit      # apply
 *   node scripts/backfill-policy-types.js --undo        # roll the last run back
 *   node scripts/backfill-policy-types.js --undo --run-id <id>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const Customer = require('../src/models/customerModel');
const LegalCase = require('../src/models/legalCase.model');
const PolicyType = require('../src/models/policyType.model');
const policyTypeService = require('../src/service/policyType.service');

const COMMIT = process.argv.includes('--commit');
const UNDO = process.argv.includes('--undo');
const RUN_ID_ARG = (() => {
  const i = process.argv.indexOf('--run-id');
  return i > -1 ? process.argv[i + 1] : null;
})();

/** The journal. Kept in its own collection so nothing else can trip over it. */
const journalSchema = new mongoose.Schema(
  {
    runId: { type: String, index: true },
    collectionName: String,
    documentId: mongoose.Schema.Types.ObjectId,
    path: String,
    from: String,
    to: String,
    undoneAt: Date,
  },
  { timestamps: true, collection: 'policytype_backfill_journal' },
);
const Journal = mongoose.models.PolicyTypeBackfillJournal
  || mongoose.model('PolicyTypeBackfillJournal', journalSchema);

/**
 * Aliases seen in the wild, mapped to the catalogue name.
 *
 * Deliberately explicit rather than fuzzy: "comp" is Comprehensive, but no
 * amount of string distance should let "commercial" become "Comprehensive".
 * Keys are compared after lowercasing and stripping everything but letters and
 * digits, so "T.P.O", "TPO" and "t p o" all arrive as "tpo".
 */
const ALIASES = {
  // Comprehensive
  comprehensive: 'Comprehensive',
  comp: 'Comprehensive',
  compre: 'Comprehensive',
  fullcover: 'Comprehensive',
  full: 'Comprehensive',
  comprehesive: 'Comprehensive',   // seen often enough to be worth catching
  comprihensive: 'Comprehensive',

  // Third Party, Fire and Theft
  tpft: 'Third Party, Fire and Theft',
  thirdpartyfireandtheft: 'Third Party, Fire and Theft',
  thirdpartyfiretheft: 'Third Party, Fire and Theft',
  thirdpartyfireandthef: 'Third Party, Fire and Theft',
  fireandtheft: 'Third Party, Fire and Theft',

  // Third Party Only
  tpo: 'Third Party Only',
  thirdparty: 'Third Party Only',
  thirdpartyonly: 'Third Party Only',
  thirdpartly: 'Third Party Only',
  tponly: 'Third Party Only',

  // Commercial
  commercial: 'Commercial Vehicle',
  commercialvehicle: 'Commercial Vehicle',
  comm: 'Commercial Vehicle',
  owngoods: 'Commercial Vehicle',
  generalcartage: 'Commercial Vehicle',

  // PSV
  psv: 'Public Service Vehicle',
  publicservicevehicle: 'Public Service Vehicle',
  matatu: 'Public Service Vehicle',

  // Motor trade
  motortrade: 'Motor Trade',
  trade: 'Motor Trade',
};

const normalise = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The catalogue name for a raw value, or null when we are not sure. */
const resolve = (raw, catalogueByKey) => {
  const key = normalise(raw);
  if (!key) return null;
  // An exact catalogue match (or its code) always wins over the alias table.
  if (catalogueByKey.has(key)) return catalogueByKey.get(key);
  return ALIASES[key] ?? null;
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const dbName = mongoose.connection.db.databaseName;

  if (UNDO) return undo(dbName);

  console.log(`Connected to ${dbName}${COMMIT ? '' : '  (DRY RUN — nothing will be written)'}\n`);

  // ── 1. The catalogue ───────────────────────────────────────────────────────
  if (COMMIT) {
    const added = await policyTypeService.seedDefaults();
    console.log(`Catalogue: ${added} built-in type(s) added.`);
  } else {
    const existing = await PolicyType.find({ company: null }).select('name').lean();
    const have = new Set(existing.map((t) => t.name));
    const missing = policyTypeService.DEFAULT_TYPES.filter((t) => !have.has(t.name)).map((t) => t.name);
    console.log(`Catalogue: ${existing.length} built-in type(s) present.`);
    if (missing.length) console.log(`           would add: ${missing.join(', ')}`);
  }

  const catalogue = await PolicyType.find({}).select('name code').lean();
  const catalogueByKey = new Map();
  catalogue.forEach((t) => {
    catalogueByKey.set(normalise(t.name), t.name);
    if (t.code) catalogueByKey.set(normalise(t.code), t.name);
  });
  console.log(`           ${catalogue.length} type(s) usable for matching.\n`);

  // ── 2. Existing records ────────────────────────────────────────────────────
  const runId = crypto.randomUUID();
  const planned = [];
  const unmatched = new Map();

  const consider = (collectionName, doc, path, raw) => {
    if (!raw || !String(raw).trim()) return;
    const to = resolve(raw, catalogueByKey);
    if (!to) {
      unmatched.set(raw, (unmatched.get(raw) ?? 0) + 1);
      return;
    }
    // Already correct — no journal entry, no write, no noise.
    if (to === raw) return;
    planned.push({ runId, collectionName, documentId: doc._id, path, from: raw, to });
  };

  const customers = await Customer.find({}).select('policyType policies').lean();
  customers.forEach((c) => {
    consider('customers', c, 'policyType', c.policyType);
    (c.policies ?? []).forEach((p, i) => consider('customers', c, `policies.${i}.policyType`, p.policyType));
  });

  const legalCases = await LegalCase.find({ 'coverSnapshot.policyType': { $exists: true, $ne: null } })
    .select('coverSnapshot.policyType').lean();
  legalCases.forEach((lc) => consider('legalcases', lc, 'coverSnapshot.policyType', lc.coverSnapshot?.policyType));

  // ── 3. Report ──────────────────────────────────────────────────────────────
  console.log(`Scanned ${customers.length} customer(s) and ${legalCases.length} legal case(s).\n`);

  if (planned.length === 0) {
    console.log('Nothing to normalise — every recognised value already matches the catalogue.');
  } else {
    const bySwap = new Map();
    planned.forEach((p) => {
      const k = `${p.from}  →  ${p.to}`;
      bySwap.set(k, (bySwap.get(k) ?? 0) + 1);
    });
    console.log(`${planned.length} value(s) to normalise:`);
    [...bySwap.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([swap, n]) => console.log(`   ${String(n).padStart(5)}  ${swap}`));
  }

  if (unmatched.size > 0) {
    console.log(`\n${unmatched.size} value(s) NOT recognised — left untouched, decide these by hand:`);
    [...unmatched.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([raw, n]) => console.log(`   ${String(n).padStart(5)}  ${JSON.stringify(raw)}`));
    console.log('\n   Add them to the catalogue, or extend ALIASES in this script, then re-run.');
  }

  if (!COMMIT) {
    console.log('\nDry run — nothing was written. Re-run with --commit to apply.');
    await mongoose.disconnect();
    return;
  }

  if (planned.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // ── 4. Apply ───────────────────────────────────────────────────────────────
  // Journal FIRST. If the process dies mid-run, --undo can still put back
  // everything that was actually changed; a journal written afterwards could
  // not.
  await Journal.insertMany(planned);

  let applied = 0;
  for (const change of planned) {
    const Model = change.collectionName === 'customers' ? Customer : LegalCase;
    // Matched on the OLD value, so a record edited by someone between the scan
    // and the write is skipped rather than overwritten.
    const res = await Model.updateOne(
      { _id: change.documentId, [change.path]: change.from },
      { $set: { [change.path]: change.to } },
    );
    if (res.modifiedCount > 0) applied += 1;
  }

  console.log(`\nApplied ${applied}/${planned.length} change(s).`);
  if (applied < planned.length) {
    console.log(`${planned.length - applied} were edited by someone else since the scan and were skipped.`);
  }
  console.log(`\nRun id: ${runId}`);
  console.log(`Undo with:  node scripts/backfill-policy-types.js --undo --run-id ${runId}`);

  await mongoose.disconnect();
};

/**
 * Put back exactly what was there.
 *
 * Matched on the value this run wrote, so a record somebody has since corrected
 * by hand is left alone rather than being dragged back to its old value.
 */
const undo = async (dbName) => {
  const runId = RUN_ID_ARG ?? (await Journal.findOne({ undoneAt: null }).sort({ createdAt: -1 }).lean())?.runId;
  if (!runId) {
    console.log('No run to undo.');
    await mongoose.disconnect();
    return;
  }

  const entries = await Journal.find({ runId, undoneAt: null }).lean();
  console.log(`Connected to ${dbName}`);
  console.log(`Undoing run ${runId} — ${entries.length} change(s).\n`);

  let reverted = 0;
  let skipped = 0;
  for (const e of entries) {
    const Model = e.collectionName === 'customers' ? Customer : LegalCase;
    const res = await Model.updateOne(
      { _id: e.documentId, [e.path]: e.to },
      { $set: { [e.path]: e.from } },
    );
    if (res.modifiedCount > 0) reverted += 1;
    else skipped += 1;
  }

  await Journal.updateMany({ runId }, { $set: { undoneAt: new Date() } });

  console.log(`Reverted ${reverted} change(s).`);
  if (skipped > 0) console.log(`${skipped} had been changed again since the run and were left as they are.`);
  console.log('\nNote: the catalogue itself is not removed — policy types are reference data,');
  console.log('and other records may already point at them. Deactivate any you do not sell.');

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
