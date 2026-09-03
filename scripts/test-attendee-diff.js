/**
 * The add/remove detection in meeting.service update(), exercised without a DB.
 * Mirrors the identity rule exactly — if this drifts, someone added to a meeting
 * silently gets no invitation, which is the failure this guards.
 */
const key = (a) => String(a.email || a.user || a.name || '').trim().toLowerCase();

const diff = (before, after) => {
  const beforeKeys = new Set(before.map(key).filter(Boolean));
  const afterKeys = new Set(after.map(key).filter(Boolean));
  return {
    added: after.filter((a) => a.email && !beforeKeys.has(key(a))).map((a) => a.name),
    removed: before.filter((a) => a.email && !afterKeys.has(key(a))).map((a) => a.name),
  };
};

const cases = [
  {
    name: 'adding one person invites only them',
    before: [{ name: 'Asha', email: 'asha@ave.com' }],
    after: [{ name: 'Asha', email: 'asha@ave.com' }, { name: 'Ben', email: 'ben@ave.com' }],
    expect: { added: ['Ben'], removed: [] },
  },
  {
    name: 'removing one person withdraws only them',
    before: [{ name: 'Asha', email: 'asha@ave.com' }, { name: 'Ben', email: 'ben@ave.com' }],
    after: [{ name: 'Asha', email: 'asha@ave.com' }],
    expect: { added: [], removed: ['Ben'] },
  },
  {
    name: 'reordering the same people mails nobody',
    before: [{ name: 'Asha', email: 'asha@ave.com' }, { name: 'Ben', email: 'ben@ave.com' }],
    after: [{ name: 'Ben', email: 'ben@ave.com' }, { name: 'Asha', email: 'asha@ave.com' }],
    expect: { added: [], removed: [] },
  },
  {
    name: 'case and whitespace differences are the same person',
    before: [{ name: 'Asha', email: 'Asha@AVE.com' }],
    after: [{ name: 'Asha', email: ' asha@ave.com ' }],
    expect: { added: [], removed: [] },
  },
  {
    name: 'a guest with no email is listed but never mailed',
    before: [],
    after: [{ name: 'Walk-in guest' }],
    expect: { added: [], removed: [] },
  },
  {
    name: 'swapping one person for another does both',
    before: [{ name: 'Asha', email: 'asha@ave.com' }],
    after: [{ name: 'Ben', email: 'ben@ave.com' }],
    expect: { added: ['Ben'], removed: ['Asha'] },
  },
];

let failed = 0;
for (const c of cases) {
  const got = diff(c.before, c.after);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(c.expect)}\n      got      ${JSON.stringify(got)}`);
}
console.log(failed === 0 ? '\nAll attendee-diff cases pass.' : `\n${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
