/**
 * Guards against notifications being rendered in the SERVER's timezone.
 *
 * Production runs on UTC while the business runs on Africa/Nairobi, so this
 * only ever fails where it matters. Run it under a UTC clock to reproduce
 * production: TZ=UTC npm run tz:test
 */
const assert = require('node:assert');
const { formatDateTime, formatShortDate, formatDate, APP_TZ } = require('../src/utils/timezone');

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

console.log(`server TZ: ${Intl.DateTimeFormat().resolvedOptions().timeZone} | business TZ: ${APP_TZ}`);
console.log('');

check('a 2pm Nairobi meeting reads as 2pm, not the UTC hour', () => {
  const out = formatDateTime(new Date('2026-09-10T14:00:00+03:00'));
  assert.ok(out.includes('14:00'), `got "${out}"`);
  assert.ok(!out.includes('11:00'), 'the UTC hour must not appear');
});

check('the zone is named, so an overseas guest is not guessing', () => {
  const out = formatDateTime(new Date('2026-09-10T14:00:00+03:00'));
  assert.ok(/GMT\+3|EAT/.test(out), `got "${out}"`);
});

check('an early-morning meeting keeps its own date', () => {
  // 01:30 Nairobi is 22:30 UTC the PREVIOUS day — the case that silently
  // reported meetings a day early.
  const out = formatDateTime(new Date('2026-09-10T01:30:00+03:00'));
  assert.ok(out.includes('10 September'), `got "${out}"`);
  assert.ok(!out.includes('9 September'), 'must not roll back a day');
});

check('a date-only value does not roll back either', () => {
  const out = formatShortDate(new Date('2026-09-10T01:30:00+03:00'));
  assert.ok(out.includes('10'), `got "${out}"`);
  assert.ok(!out.includes('09/09') && !out.includes('9/9'), 'must not report the previous day');
});

check('a late-evening deadline does not roll forward', () => {
  const out = formatShortDate(new Date('2026-09-10T23:30:00+03:00'));
  assert.ok(out.includes('10'), `got "${out}"`);
});

check('formatDate spells the month in the business zone', () => {
  const out = formatDate(new Date('2026-09-10T01:30:00+03:00'));
  assert.strictEqual(out, '10 September 2026');
});

check('missing values return null rather than "Invalid Date"', () => {
  assert.strictEqual(formatDateTime(null), null);
  assert.strictEqual(formatShortDate(undefined), null);
  assert.strictEqual(formatDate(''), null);
});

console.log('');
console.log(process.exitCode ? 'FAILURES above' : `${passed} checks passed`);
