/**
 * Meeting reminder timing, without a database.
 *
 * The failure mode this guards is silent in both directions: a window too
 * narrow and a meeting slips between two sweeps with no reminder at all; a
 * window too wide, or an offset re-sent, and everyone is pinged twice. Neither
 * shows up in a log — you find out from the person who missed the call.
 */
const path = require('node:path');
const { dueOffsets, SWEEP_WINDOW_MINUTES } = require(path.join(__dirname, '..', 'src/service/meetingReminder.service'));

const NOW = new Date('2026-09-05T09:00:00Z');
const inMinutes = (m) => new Date(NOW.getTime() + m * 60000);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
};

const meeting = (minutesAway, sent = []) => ({
  startAt: inMinutes(minutesAway),
  remindersSent: sent.map((offsetMinutes) => ({ offsetMinutes })),
});

// Exactly on the mark.
check('a meeting 30 minutes away is due',
  dueOffsets(meeting(30), NOW).includes(30));

// Just inside the window — the sweep that runs a few minutes late still catches it.
check('a meeting 26 minutes away is still due',
  dueOffsets(meeting(26), NOW).includes(30));

// The whole five-minute gap between sweeps must be covered, or a meeting whose
// 30-minute mark falls between two runs is never reminded.
const covered = [];
for (let m = 30; m > 30 - 5; m -= 1) {
  if (dueOffsets(meeting(m), NOW).includes(30)) covered.push(m);
}
check('every minute between consecutive sweeps is covered',
  covered.length === 5, `covered ${covered.length}/5: ${covered.join(', ')}`);

// Too early — a meeting two hours out must not be reminded yet.
check('a meeting 120 minutes away is not yet due',
  dueOffsets(meeting(120), NOW).length === 0);

check('a meeting 31 minutes away is not yet due',
  dueOffsets(meeting(31), NOW).length === 0);

// Too late — a worker that has been down must not send "starting in 30 minutes"
// about a meeting that began an hour ago.
check('a meeting that started an hour ago gets nothing',
  dueOffsets(meeting(-60), NOW).length === 0);

check('a meeting past the sweep window gets nothing',
  dueOffsets(meeting(30 - SWEEP_WINDOW_MINUTES), NOW).length === 0);

// Idempotence — the property BullMQ retries depend on.
check('an offset already sent is never sent again',
  dueOffsets(meeting(30, [30]), NOW).length === 0);

check('a retried sweep is a no-op once recorded',
  dueOffsets(meeting(28, [30]), NOW).length === 0);

const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? '\nAll meeting reminder cases pass.' : `\n${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
