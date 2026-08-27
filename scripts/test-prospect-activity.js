/**
 * Checks for the prospect pipeline's derived activity — no database.
 *
 * Mirrors the matching and "cold" rules in prospect.service.js so the parts that
 * would fail silently (a prospect matching the wrong insurer's meetings, or a
 * live prospect being flagged cold) are exercised directly.
 *
 * Run: npm run prospect:test-activity
 */
const assert = require('node:assert');

const COLD_AFTER_DAYS = 21;
const OPEN_STAGES = ['new', 'engaged', 'evaluating', 'proposal'];

const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);
const days = (from) => (from ? Math.floor((Date.now() - new Date(from)) / 86400000) : null);

/** Mirrors `belongs` in the service. */
const belongs = (meeting, prospect) => {
  if (meeting.prospect && String(meeting.prospect) === String(prospect._id)) return true;
  const pCompany = prospect.company;
  if (pCompany && meeting.client?.company && String(meeting.client.company) === String(pCompany)) return true;
  const mName = meeting.client?.name?.trim().toLowerCase();
  return Boolean(mName && mName === String(prospect.name).trim().toLowerCase());
};

/** Mirrors the activity block in `withActivity`. */
const activityFor = (prospect, meetings) => {
  const now = new Date();
  const mine = meetings.filter((m) => belongs(m, prospect));
  const held = mine.filter((m) => m.status === 'completed');
  const demosHeld = held.filter((m) => m.type === 'client_demo').length;
  const lastContactAt = held.map((m) => m.startAt).sort((a, b) => new Date(b) - new Date(a))[0] ?? null;
  const next = mine
    .filter((m) => m.status === 'scheduled' && new Date(m.startAt) >= now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0] ?? null;
  const daysSinceContact = days(lastContactAt);
  const open = OPEN_STAGES.includes(prospect.stage);

  return {
    meetingsHeld: held.length,
    demosHeld,
    lastContactAt,
    daysSinceContact,
    nextMeetingAt: next?.startAt ?? null,
    cold:
      open &&
      !next &&
      (daysSinceContact === null
        ? days(prospect.createdAt) >= COLD_AFTER_DAYS
        : daysSinceContact >= COLD_AFTER_DAYS),
  };
};

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

const jubilee = { _id: 'p1', name: 'Jubilee Insurance', company: 'c1', stage: 'engaged', createdAt: daysAgo(90) };

console.log('matching');

check('matches by explicit prospect link', () => {
  const m = { prospect: 'p1', status: 'completed', type: 'client_demo', startAt: daysAgo(3) };
  assert.strictEqual(belongs(m, jubilee), true);
});

check('matches by company', () => {
  const m = { client: { company: 'c1' }, status: 'completed', type: 'client_demo', startAt: daysAgo(3) };
  assert.strictEqual(belongs(m, jubilee), true);
});

check('matches by client name, ignoring case and spacing', () => {
  const m = { client: { name: '  jubilee insurance ' }, status: 'completed', type: 'client_demo', startAt: daysAgo(3) };
  assert.strictEqual(belongs(m, jubilee), true);
});

check('does NOT match a different insurer whose name merely contains ours', () => {
  // The whole point of anchoring the name regex.
  const m = { client: { name: 'Jubilee Insurance Holdings Uganda' }, status: 'completed', startAt: daysAgo(1) };
  assert.strictEqual(belongs(m, jubilee), false);
});

check('does not match another company', () => {
  const m = { client: { company: 'c2', name: 'Britam' }, status: 'completed', startAt: daysAgo(1) };
  assert.strictEqual(belongs(m, jubilee), false);
});

console.log('activity');

check('counts only completed meetings, and demos separately', () => {
  const a = activityFor(jubilee, [
    { prospect: 'p1', status: 'completed', type: 'client_demo', startAt: daysAgo(30) },
    { prospect: 'p1', status: 'completed', type: 'client_meeting', startAt: daysAgo(10) },
    { prospect: 'p1', status: 'scheduled', type: 'client_demo', startAt: daysAhead(5) },
    { prospect: 'p1', status: 'cancelled', type: 'client_demo', startAt: daysAgo(2) },
  ]);
  assert.strictEqual(a.meetingsHeld, 2, 'scheduled and cancelled are not "held"');
  assert.strictEqual(a.demosHeld, 1);
});

check('last contact is the most recent completed meeting', () => {
  const a = activityFor(jubilee, [
    { prospect: 'p1', status: 'completed', type: 'client_demo', startAt: daysAgo(30) },
    { prospect: 'p1', status: 'completed', type: 'client_meeting', startAt: daysAgo(4) },
  ]);
  assert.strictEqual(a.daysSinceContact, 4);
});

check('next meeting is the soonest FUTURE scheduled one', () => {
  const a = activityFor(jubilee, [
    { prospect: 'p1', status: 'scheduled', startAt: daysAhead(20) },
    { prospect: 'p1', status: 'scheduled', startAt: daysAhead(2) },
    { prospect: 'p1', status: 'scheduled', startAt: daysAgo(5) }, // in the past, ignored
  ]);
  assert.strictEqual(days(a.nextMeetingAt), -2, 'two days out');
});

console.log('cold');

check('silent for longer than the threshold is cold', () => {
  const a = activityFor(jubilee, [{ prospect: 'p1', status: 'completed', startAt: daysAgo(40) }]);
  assert.strictEqual(a.cold, true);
});

check('a booked meeting is never cold, however long the gap', () => {
  const a = activityFor(jubilee, [
    { prospect: 'p1', status: 'completed', startAt: daysAgo(200) },
    { prospect: 'p1', status: 'scheduled', startAt: daysAhead(30) },
  ]);
  assert.strictEqual(a.cold, false, 'something is in the diary');
});

check('recent contact is not cold', () => {
  const a = activityFor(jubilee, [{ prospect: 'p1', status: 'completed', startAt: daysAgo(3) }]);
  assert.strictEqual(a.cold, false);
});

check('never contacted is judged from when it was added', () => {
  const fresh = { ...jubilee, createdAt: daysAgo(2) };
  const stale = { ...jubilee, createdAt: daysAgo(60) };
  assert.strictEqual(activityFor(fresh, []).cold, false, 'added two days ago');
  assert.strictEqual(activityFor(stale, []).cold, true, 'added two months ago, never contacted');
});

check('won and lost prospects are never cold', () => {
  for (const stage of ['won', 'lost', 'dormant']) {
    const p = { ...jubilee, stage };
    assert.strictEqual(activityFor(p, []).cold, false, `${stage} should not be chased`);
  }
});

console.log('');
console.log(process.exitCode ? 'FAILURES above' : `${passed} checks passed`);
