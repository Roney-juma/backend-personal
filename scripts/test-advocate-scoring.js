/**
 * Checks for advocate scoring — no database, no network.
 *
 * Mirrors the arithmetic in advocate.service.js (winRate denominator, the
 * reliability and specialism factors, and weight normalisation) so the rules
 * can be exercised directly. Run: npm run advocate:test-scoring
 */
const assert = require('node:assert');
const { DEFAULT_ALLOCATION_WEIGHTS } = require('../src/constants/legal.constants');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    console.log('  FAIL ' + name + ' — ' + err.message);
    process.exitCode = 1;
  }
};

// ── Win rate ────────────────────────────────────────────────────────────────
// The rule: successful defences over ADJUDICATED matters, not over everything
// that closed.
const winRate = (closed) => {
  const adjudicated = closed.filter((c) => c.liabilityOutcome);
  const wins = adjudicated.filter((c) =>
    ['for_insurer', 'dismissed', 'struck_out'].includes(c.liabilityOutcome)
  ).length;
  return {
    winRate: adjudicated.length ? wins / adjudicated.length : 0,
    adjudicatedMatters: adjudicated.length,
    settledMatters: closed.length - adjudicated.length,
  };
};

console.log('winRate');

check('a settlement is not counted as a loss', () => {
  // Eight settled, two judgments both won. The old rule gave 2/10 = 20%.
  const closed = [
    ...Array.from({ length: 8 }, () => ({})),
    { liabilityOutcome: 'for_insurer' },
    { liabilityOutcome: 'dismissed' },
  ];
  const r = winRate(closed);
  assert.strictEqual(r.winRate, 1, 'both adjudicated matters were won');
  assert.strictEqual(r.adjudicatedMatters, 2);
  assert.strictEqual(r.settledMatters, 8);
});

check('losses still count against it', () => {
  const r = winRate([
    { liabilityOutcome: 'for_insurer' },
    { liabilityOutcome: 'for_claimant' },
    { liabilityOutcome: 'apportioned' },
    { liabilityOutcome: 'struck_out' },
  ]);
  assert.strictEqual(r.winRate, 0.5, '2 of 4 adjudicated');
});

check('an advocate who has never been to judgment scores 0, not NaN', () => {
  const r = winRate([{}, {}, {}]);
  assert.strictEqual(r.winRate, 0);
  assert.strictEqual(r.adjudicatedMatters, 0);
});

// ── Reliability ─────────────────────────────────────────────────────────────
const reliability = (overdueActions, outstandingReports, openMatters) => {
  const lapses = overdueActions + outstandingReports;
  return Math.max(0, 1 - lapses / Math.max(openMatters, 1));
};

console.log('reliability');

check('a clean advocate scores 1', () => {
  assert.strictEqual(reliability(0, 0, 10), 1);
});
check('lapses are judged against the load being carried', () => {
  const busy = reliability(2, 0, 30);
  const light = reliability(2, 0, 3);
  assert.ok(busy > light, 'two lapses across 30 matters beats two across 3');
});
check('it floors at 0 rather than going negative', () => {
  assert.strictEqual(reliability(50, 50, 2), 0);
});
check('outstanding reports count the same as overdue actions', () => {
  assert.strictEqual(reliability(3, 0, 6), reliability(0, 3, 6));
});

// ── Specialism ──────────────────────────────────────────────────────────────
const NEUTRAL = 0.5;
const specialism = (areas, claimType) => {
  const list = (areas || []).map((a) => String(a).toLowerCase());
  if (!claimType || list.length === 0) return NEUTRAL;
  const want = String(claimType).toLowerCase();
  return list.some((a) => a === want || a.includes(want)) ? 1 : 0.3;
};

console.log('specialism');

check('a declared match scores full', () => {
  assert.strictEqual(specialism(['bodily_injury', 'recovery'], 'bodily_injury'), 1);
});
check('no declared areas is neutral, not a penalty', () => {
  assert.strictEqual(specialism([], 'bodily_injury'), NEUTRAL);
});
check('no claim type asked for is neutral', () => {
  assert.strictEqual(specialism(['bodily_injury'], undefined), NEUTRAL);
});
check('a mismatch is discounted but not disqualifying', () => {
  const s = specialism(['property_damage'], 'fatal');
  assert.ok(s > 0 && s < NEUTRAL, 'still instructable, just ranked lower');
});

// ── Weight normalisation ────────────────────────────────────────────────────
const score = (factors, weights) => {
  const applied = Object.keys(factors).map((k) => ({
    key: k,
    weight: weights[k] ?? DEFAULT_ALLOCATION_WEIGHTS[k] ?? 0,
  }));
  const total = applied.reduce((a, f) => a + f.weight, 0);
  const weighted = applied.reduce((a, f) => a + factors[f.key] * f.weight, 0);
  return total > 0 ? weighted / total : 0;
};

const ALL_ONE = {
  proximity: 1, availability: 1, winRate: 1, savings: 1,
  turnaround: 1, reliability: 1, specialism: 1,
};

console.log('scoring');

check('a perfect advocate scores 1 under the defaults', () => {
  assert.strictEqual(Math.round(score(ALL_ONE, DEFAULT_ALLOCATION_WEIGHTS) * 1000) / 1000, 1);
});

check('a perfect advocate still scores 1 when a tenant zeroes a factor', () => {
  const custom = { ...DEFAULT_ALLOCATION_WEIGHTS, savings: 0 };
  assert.strictEqual(Math.round(score(ALL_ONE, custom) * 1000) / 1000, 1);
});

check('a tenant config predating the new factors still applies them', () => {
  // An old stored config with only the original five keys.
  const old = { proximity: 0.2, availability: 0.25, winRate: 0.2, savings: 0.2, turnaround: 0.15 };
  const unreliable = { ...ALL_ONE, reliability: 0 };
  assert.ok(
    score(unreliable, old) < score(ALL_ONE, old),
    'reliability falls back to its default weight rather than 0'
  );
});

check('an explicit zero is honoured over the default', () => {
  const optOut = { ...DEFAULT_ALLOCATION_WEIGHTS, reliability: 0 };
  const unreliable = { ...ALL_ONE, reliability: 0 };
  assert.strictEqual(score(unreliable, optOut), score(ALL_ONE, optOut));
});

check('every score lands within 0..1', () => {
  const worst = Object.fromEntries(Object.keys(ALL_ONE).map((k) => [k, 0]));
  assert.strictEqual(score(worst, DEFAULT_ALLOCATION_WEIGHTS), 0);
  assert.ok(score(ALL_ONE, DEFAULT_ALLOCATION_WEIGHTS) <= 1);
});

check('the default weights still sum to 1', () => {
  const sum = Object.values(DEFAULT_ALLOCATION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum was ${sum}`);
});

console.log('');
console.log(process.exitCode ? 'FAILURES above' : `${passed} checks passed`);
