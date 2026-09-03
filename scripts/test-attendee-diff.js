/**
 * diffAttendees from meeting.service, exercised without a database.
 *
 * If this drifts, someone added to a meeting silently gets no invitation —
 * which is the exact failure the diff exists to prevent, and the one nobody
 * notices until they turn up to an empty room.
 */
const { diffAttendees } = require('../src/service/meeting.service');

const names = (list) => list.map((a) => a.name);

const cases = [
  {
    name: 'adding one person invites only them',
    before: [{ name: 'Asha', email: 'asha@ave.com' }],
    after: [{ name: 'Asha', email: 'asha@ave.com' }, { name: 'Ben', email: 'ben@ave.com' }],
    expect: { invited: ['Ben'], removed: [], unreachable: [] },
  },
  {
    name: 'removing one person withdraws only them',
    before: [{ name: 'Asha', email: 'asha@ave.com' }, { name: 'Ben', email: 'ben@ave.com' }],
    after: [{ name: 'Asha', email: 'asha@ave.com' }],
    expect: { invited: [], removed: ['Ben'], unreachable: [] },
  },
  {
    name: 'reordering the same people mails nobody',
    before: [{ name: 'Asha', email: 'asha@ave.com' }, { name: 'Ben', email: 'ben@ave.com' }],
    after: [{ name: 'Ben', email: 'ben@ave.com' }, { name: 'Asha', email: 'asha@ave.com' }],
    expect: { invited: [], removed: [], unreachable: [] },
  },
  {
    name: 'case and whitespace differences are the same person',
    before: [{ name: 'Asha', email: 'Asha@AVE.com' }],
    after: [{ name: 'Asha', email: ' asha@ave.com ' }],
    expect: { invited: [], removed: [], unreachable: [] },
  },
  {
    name: 'a new guest with no email is reported as unreachable, not invited',
    before: [],
    after: [{ name: 'Walk-in guest' }],
    expect: { invited: [], removed: [], unreachable: ['Walk-in guest'] },
  },
  {
    name: 'an existing email-less guest is not reported again',
    before: [{ name: 'Walk-in guest' }],
    after: [{ name: 'Walk-in guest' }],
    expect: { invited: [], removed: [], unreachable: [] },
  },
  {
    name: 'swapping one person for another does both',
    before: [{ name: 'Asha', email: 'asha@ave.com' }],
    after: [{ name: 'Ben', email: 'ben@ave.com' }],
    expect: { invited: ['Ben'], removed: ['Asha'], unreachable: [] },
  },
  {
    name: 'an existing row sent back with its user populated is not re-invited',
    before: [{ name: 'Asha', email: 'asha@ave.com', user: 'u1' }],
    after: [{ name: 'Asha', email: 'asha@ave.com', user: { _id: 'u1', fullName: 'Asha' } }],
    expect: { invited: [], removed: [], unreachable: [] },
  },
];

let failed = 0;
for (const c of cases) {
  const got = diffAttendees(c.before, c.after);
  const flat = { invited: names(got.invited), removed: names(got.removed), unreachable: got.unreachable };
  const ok = JSON.stringify(flat) === JSON.stringify(c.expect);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(c.expect)}\n      got      ${JSON.stringify(flat)}`);
}
console.log(failed === 0 ? '\nAll attendee-diff cases pass.' : `\n${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
