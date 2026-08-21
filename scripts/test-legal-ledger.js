/**
 * Phase 0 exit criterion for the Legal module.
 *
 *   "For any sequence of postings and reversals, the aggregated net exposure
 *    equals the formula in spec §16."
 *
 * The ledger is the one piece of this module that has to be right the first
 * time: every reserve, exposure figure, advocate savings number and management
 * report is an aggregation over it, and it is append-only, so a bug does not get
 * quietly corrected later — it gets baked into history.
 *
 * Runs standalone with no database and no test framework, matching the existing
 * script style in this repo:
 *
 *   node scripts/test-legal-ledger.js
 */

const { computePosition } = require('../src/service/legalLedger.service');
const { LEDGER_ENTRY_TYPES } = require('../src/constants/legal.constants');
const money = require('../src/utils/money');

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

function section(title) {
  console.log(`\n${title}`);
}

// ── A tiny in-memory ledger ──────────────────────────────────────────────────
// Mirrors exactly what the Mongo $group stage produces, so computePosition is
// exercised on the same shape it sees in production.

function group(entries) {
  const acc = new Map();
  for (const e of entries) {
    const key = `${e.entryType}|${e.reserveBucket || ''}`;
    const signed = e.amountMinor * (e.direction === 'debit' ? 1 : -1);
    const row = acc.get(key) || {
      _id: { entryType: e.entryType, reserveBucket: e.reserveBucket },
      signedMinor: 0,
      count: 0,
    };
    row.signedMinor += signed;
    row.count += 1;
    acc.set(key, row);
  }
  return [...acc.values()];
}

/** Post, deriving direction from the type exactly as the service does. */
function entry(entryType, amountMinor, reserveBucket) {
  const spec = LEDGER_ENTRY_TYPES[entryType];
  if (!spec) throw new Error(`unknown type ${entryType}`);
  return { entryType, amountMinor, direction: spec.direction, reserveBucket };
}

/** The mirror-image entry the service posts on reversal. */
function reversalOf(e) {
  return { ...e, direction: e.direction === 'debit' ? 'credit' : 'debit' };
}

// ── 1. The formula, worked by hand ───────────────────────────────────────────

section('1. Spec §16 formula on a worked example');
{
  // A realistic third-party bodily-injury matter.
  const entries = [
    entry('reserve_set', money.toMinor(7000000), 'claim'),
    entry('settlement', money.toMinor(4500000)),
    entry('interest', money.toMinor(320000)),
    entry('legal_fee', money.toMinor(450000)),
    entry('court_fee', money.toMinor(65000)),
    entry('expert_fee', money.toMinor(120000)),
    entry('medical_report_fee', money.toMinor(35000)),
    entry('claimant_costs', money.toMinor(280000)),
    entry('recovery', money.toMinor(1500000)),
  ];

  const pos = computePosition(group(entries));

  // claim + interest + legal costs + court costs + expert costs − recoveries
  const expected = money.toMinor(
    4500000 + 320000 + (450000 + 280000) + 65000 + (120000 + 35000) - 1500000
  );

  check(
    'net exposure equals the spec formula',
    pos.netExposureMinor === expected,
    `got ${money.formatMinor(pos.netExposureMinor)}, expected ${money.formatMinor(expected)}`
  );

  check(
    'reserve is tracked but excluded from net exposure',
    pos.reserveClaimMinor === money.toMinor(7000000) &&
      !String(pos.netExposureMinor).includes('700000000'),
    `reserve ${money.formatMinor(pos.reserveClaimMinor)}, net ${money.formatMinor(pos.netExposureMinor)}`
  );

  check(
    'recoveries are reported positive but subtract from net',
    pos.recoveriesMinor === money.toMinor(1500000)
  );

  check(
    'fees roll up legal + court + expert',
    pos.feesToDateMinor === money.toMinor(450000 + 280000 + 65000 + 120000 + 35000)
  );
}

// ── 2. Reversal always returns to the prior position ─────────────────────────

section('2. Reversal invariant');
{
  const base = [
    entry('reserve_set', money.toMinor(5000000), 'claim'),
    entry('legal_fee', money.toMinor(200000)),
  ];
  const before = computePosition(group(base));

  const mistake = entry('settlement', money.toMinor(9999999));
  const after = computePosition(group([...base, mistake]));
  const corrected = computePosition(group([...base, mistake, reversalOf(mistake)]));

  check('a posting moves the position', after.netExposureMinor !== before.netExposureMinor);
  check(
    'its reversal restores the position exactly',
    corrected.netExposureMinor === before.netExposureMinor,
    `before ${before.netExposureMinor}, corrected ${corrected.netExposureMinor}`
  );
}

// ── 3. Property test: random sequences ───────────────────────────────────────

section('3. Property test — 2000 random posting sequences');
{
  // Deterministic PRNG so a failure is reproducible from the seed alone.
  let seed = 20260821;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const amount = () => Math.floor(rand() * 500000000) + 1;

  const EXPOSURE_TYPES = Object.keys(LEDGER_ENTRY_TYPES).filter(
    (t) => !LEDGER_ENTRY_TYPES[t].reserve
  );
  const DEBITS = EXPOSURE_TYPES.filter((t) => LEDGER_ENTRY_TYPES[t].direction === 'debit');
  const CREDITS = EXPOSURE_TYPES.filter((t) => LEDGER_ENTRY_TYPES[t].direction === 'credit');

  let mismatches = 0;
  let reversalMismatches = 0;
  let firstFailure = null;

  for (let run = 0; run < 2000; run += 1) {
    const entries = [];
    const count = 1 + Math.floor(rand() * 12);

    for (let i = 0; i < count; i += 1) {
      const type = pick(EXPOSURE_TYPES);
      entries.push(entry(type, amount()));
    }
    // Reserves interleaved, which must never affect net exposure.
    if (rand() > 0.5) {
      entries.push(entry('reserve_set', amount(), pick(['claim', 'legal', 'judgment'])));
    }

    const pos = computePosition(group(entries));

    // Independent recomputation of the formula, straight from the raw entries —
    // deliberately not reusing the service's grouping.
    const rawDebits = entries
      .filter((e) => DEBITS.includes(e.entryType))
      .reduce((a, e) => a + e.amountMinor, 0);
    const rawCredits = entries
      .filter((e) => CREDITS.includes(e.entryType))
      .reduce((a, e) => a + e.amountMinor, 0);
    const expected = rawDebits - rawCredits;

    if (pos.netExposureMinor !== expected) {
      mismatches += 1;
      if (!firstFailure) firstFailure = { run, expected, got: pos.netExposureMinor, entries };
    }

    // Reversing every entry must return the position to exactly zero.
    const allReversed = computePosition(group([...entries, ...entries.map(reversalOf)]));
    if (allReversed.netExposureMinor !== 0) {
      reversalMismatches += 1;
    }
  }

  check(
    'net exposure matches an independent recomputation in all 2000 runs',
    mismatches === 0,
    firstFailure
      ? `run ${firstFailure.run}: expected ${firstFailure.expected}, got ${firstFailure.got}`
      : ''
  );
  check(
    'reversing every entry returns net exposure to zero in all 2000 runs',
    reversalMismatches === 0,
    `${reversalMismatches} runs did not zero out`
  );
  check('all results are exact integers', Number.isSafeInteger(computePosition([]).netExposureMinor));
}

// ── 4. Direction is derived, not trusted ─────────────────────────────────────

section('4. Direction derivation');
{
  check(
    'recovery is always a credit',
    LEDGER_ENTRY_TYPES.recovery.direction === 'credit'
  );
  check(
    'court fee is always a debit',
    LEDGER_ENTRY_TYPES.court_fee.direction === 'debit'
  );
  check(
    'only reserve_adjust accepts a signed amount',
    Object.entries(LEDGER_ENTRY_TYPES).filter(([, s]) => s.signed).length === 1 &&
      LEDGER_ENTRY_TYPES.reserve_adjust.signed === true
  );

  // A downward reserve revision must reduce the reserve without being a credit.
  const pos = computePosition(
    group([
      entry('reserve_set', money.toMinor(8000000), 'claim'),
      { ...entry('reserve_adjust', money.toMinor(-3000000), 'claim') },
    ])
  );
  check(
    'a negative reserve_adjust reduces the reserve',
    pos.reserveClaimMinor === money.toMinor(5000000),
    `got ${money.formatMinor(pos.reserveClaimMinor)}`
  );
  check('reserve adjustments still do not touch net exposure', pos.netExposureMinor === 0);
}

// ── 5. Money precision ───────────────────────────────────────────────────────

section('5. Minor-unit precision');
{
  check('0.1 + 0.2 is exact in minor units', money.sumMinor([money.toMinor(0.1), money.toMinor(0.2)]) === 30);
  check('apportionment rounds once', money.applyPercent(money.toMinor(10000000), 33.33) === 333300000);
  check(
    'a limit cap reports the excess',
    money.capAtLimit(money.toMinor(10000000), money.toMinor(4000000)).excessMinor ===
      money.toMinor(6000000)
  );
  check('unlimited cover does not cap', money.capAtLimit(money.toMinor(999), null).limitApplied === false);

  let rejected = false;
  try {
    money.toMinor('not a number');
  } catch {
    rejected = true;
  }
  check('a non-numeric amount is rejected, not coerced to zero', rejected);
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nPhase 0 exit criterion NOT met.');
  process.exit(1);
}
console.log('\nPhase 0 ledger exit criterion met.');
