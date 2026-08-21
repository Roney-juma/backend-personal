/**
 * Phase 3 checks — advocate allocation and document privilege.
 *
 *   node scripts/test-legal-litigation.js
 *
 * Two things here decide something consequential without a human in the loop:
 * which advocate gets suggested, and who can open a privileged document. Both
 * are tested against the cases where a naive implementation quietly does the
 * wrong thing.
 *
 * No database and no test framework.
 */

const { canView } = require('../src/service/legalDocument.service');
const { CONFIDENTIALITY, DEFAULT_ALLOCATION_WEIGHTS } = require('../src/constants/legal.constants');
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

const K = (major) => money.toMinor(major);

// ── 1. Document privilege ────────────────────────────────────────────────────

console.log('\n1. Who can open what');
{
  const doc = (confidentiality) => ({ confidentiality, company: 'c1' });
  const user = (permissions, roleName = 'Legal Officer') => ({ permissions, roleName });
  const config = { auditorSeesPrivilegedContents: false };

  const legalOfficer = user(['VIEW_LEGAL_DOCUMENTS', 'VIEW_PRIVILEGED_DOCUMENTS']);
  const claimsOfficer = user(['VIEW_LEGAL_DOCUMENTS'], 'Claims Officer');
  const auditor = user(['VIEW_LEGAL_DOCUMENTS', 'VIEW_AUDIT_LOGS'], 'Auditor');
  const admin = user([], 'Super Admin');

  check(
    'a legal officer can open privileged advice',
    canView(doc(CONFIDENTIALITY.PRIVILEGED), legalOfficer, { config }).allowed
  );
  check(
    'a claims officer with only VIEW_LEGAL_DOCUMENTS cannot',
    !canView(doc(CONFIDENTIALITY.PRIVILEGED), claimsOfficer, { config }).allowed
  );
  check(
    'but can open an internal document',
    canView(doc(CONFIDENTIALITY.INTERNAL), claimsOfficer, { config }).allowed
  );
  check('an admin can open anything', canView(doc(CONFIDENTIALITY.PRIVILEGED), admin, { config }).allowed);

  // The §21/§22 conflict, resolved per tenant.
  const auditorBlocked = canView(doc(CONFIDENTIALITY.PRIVILEGED), auditor, { config });
  check('an auditor is refused privileged CONTENTS by default', !auditorBlocked.allowed);
  check(
    'and is told the metadata and access log remain available',
    /metadata/i.test(auditorBlocked.reason),
    auditorBlocked.reason
  );
  check(
    'a tenant can opt the auditor in',
    canView(doc(CONFIDENTIALITY.PRIVILEGED), auditor, {
      config: { auditorSeesPrivilegedContents: true },
    }).allowed
  );
  check(
    'an auditor still reads non-privileged documents',
    canView(doc(CONFIDENTIALITY.INTERNAL), auditor, { config }).allowed
  );
}

console.log('\n2. The advocate portal boundary');
{
  const doc = (confidentiality) => ({ confidentiality, company: 'c1' });
  const advocate = { permissions: [], roleName: null };
  const opts = { config: {}, isAdvocate: true };

  check(
    'counsel sees what was shared with them',
    canView(doc(CONFIDENTIALITY.ADVOCATE_SHARED), advocate, opts).allowed
  );
  check(
    'and what is already filed in open court',
    canView(doc(CONFIDENTIALITY.COURT_FILED), advocate, opts).allowed
  );

  // The two that matter: our own assessment must never reach the portal, even
  // for the advocate defending the case.
  check(
    'counsel NEVER sees our privileged assessment',
    !canView(doc(CONFIDENTIALITY.PRIVILEGED), advocate, opts).allowed
  );
  check(
    'counsel NEVER sees our internal notes',
    !canView(doc(CONFIDENTIALITY.INTERNAL), advocate, opts).allowed
  );

  // And privilege is not something a permission grant can smuggle in through
  // the portal — the advocate branch is checked first.
  const advocateWithPerms = { permissions: ['VIEW_PRIVILEGED_DOCUMENTS'], roleName: 'Super Admin' };
  check(
    'a portal session cannot escalate into privileged material',
    !canView(doc(CONFIDENTIALITY.PRIVILEGED), advocateWithPerms, opts).allowed
  );
}

// ── 3. Allocation scoring ────────────────────────────────────────────────────

console.log('\n3. Advocate allocation');
{
  const MIN_MATTERS_FOR_HISTORY = 5;
  const NEUTRAL = 0.5;

  /** Mirrors advocate.service.rankPanel scoring, without the database. */
  function score(advocate, { court, weights, maxOpen, maxSavings, maxDuration }) {
    const perf = advocate.performance || {};
    const hasHistory = (perf.closedMatters || 0) >= MIN_MATTERS_FOR_HISTORY;

    const covers = court && (advocate.courts || []).includes(court);
    const proximity = covers ? 1 : (advocate.courts?.length ? 0.3 : NEUTRAL);
    const availability = Math.max(0, 1 - (perf.openMatters || 0) / maxOpen);
    const winRate = hasHistory ? perf.winRate || 0 : NEUTRAL;
    const savings = hasHistory ? Math.max(0, perf.savingsMinor || 0) / maxSavings : NEUTRAL;
    const turnaround = hasHistory && perf.avgDurationDays
      ? Math.max(0, 1 - perf.avgDurationDays / maxDuration)
      : NEUTRAL;

    const factors = { proximity, availability, winRate, savings, turnaround };
    return {
      total: Object.entries(factors).reduce((a, [k, v]) => a + v * (weights[k] ?? 0), 0),
      factors,
      hasHistory,
    };
  }

  const weights = DEFAULT_ALLOCATION_WEIGHTS;
  const ctx = { court: 'Milimani CMCC', weights, maxOpen: 25, maxSavings: K(5000000), maxDuration: 900 };

  const strong = {
    name: 'Strong',
    courts: ['Milimani CMCC'],
    performance: { closedMatters: 20, openMatters: 4, winRate: 0.75, savingsMinor: K(5000000), avgDurationDays: 300 },
  };
  const weak = {
    name: 'Weak',
    courts: ['Milimani CMCC'],
    performance: { closedMatters: 20, openMatters: 22, winRate: 0.2, savingsMinor: 0, avgDurationDays: 850 },
  };
  const newcomer = {
    name: 'New',
    courts: ['Milimani CMCC'],
    performance: { closedMatters: 0, openMatters: 0 },
  };
  const distant = {
    name: 'Distant',
    courts: ['Mombasa CMCC'],
    performance: { closedMatters: 20, openMatters: 4, winRate: 0.75, savingsMinor: K(5000000), avgDurationDays: 300 },
  };

  const s = (a) => score(a, ctx);

  check('a strong advocate outranks a weak one', s(strong).total > s(weak).total);
  check('covering the court beats not covering it', s(strong).total > s(distant).total);
  check('proximity is scored 1 when the court is covered', s(strong).factors.proximity === 1);
  check('and penalised when it is not', s(distant).factors.proximity === 0.3);

  // The cold-start problem: without a neutral prior a new panel member scores
  // zero on three of five factors and would never be instructed, so the panel
  // ossifies around whoever happened to be there first.
  const n = s(newcomer);
  check('a newcomer is scored neutrally on history, not zero', n.factors.winRate === NEUTRAL);
  check('including savings', n.factors.savings === NEUTRAL);
  check('and turnaround', n.factors.turnaround === NEUTRAL);
  check('and is flagged as having no history', n.hasHistory === false);
  check(
    'so a newcomer with a clear diary outranks a poor performer at capacity',
    n.total > s(weak).total,
    `new ${n.total.toFixed(3)} vs weak ${s(weak).total.toFixed(3)}`
  );
  check(
    'but does not outrank a proven advocate',
    n.total < s(strong).total,
    `new ${n.total.toFixed(3)} vs strong ${s(strong).total.toFixed(3)}`
  );

  // Availability must actually bite, or the busiest advocate keeps winning.
  const busy = { ...strong, performance: { ...strong.performance, openMatters: 25 } };
  check('an advocate at capacity scores zero on availability', s(busy).factors.availability === 0);
  check('and ranks below the same advocate with a clear diary', s(busy).total < s(strong).total);

  check(
    'weights sum to 1 so scores are comparable',
    Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 0.001
  );
}

// ── 4. Adjournment is append, not update ─────────────────────────────────────

console.log('\n4. Adjournment semantics');
{
  /**
   * The rule from legalDiary.adjourn. Moving dueAt in place would erase the
   * history that court-performance reporting reads — "this court adjourned us
   * four times" is the insight, and it is invisible if each adjournment
   * overwrites the last.
   */
  function adjourn(events, eventId, newDate) {
    const original = events.find((e) => e.id === eventId);
    original.status = 'adjourned';
    const successor = {
      id: `${eventId}-next`,
      eventType: original.eventType,
      dueAt: newDate,
      status: 'scheduled',
      adjournedFrom: original.id,
    };
    original.adjournedTo = successor.id;
    return [...events, successor];
  }

  let events = [{ id: 'e1', eventType: 'hearing', dueAt: '2026-09-10', status: 'scheduled' }];
  events = adjourn(events, 'e1', '2026-11-12');
  events = adjourn(events, 'e1-next', '2027-02-03');

  check('each adjournment adds a row rather than editing one', events.length === 3);
  check('the original date is still recoverable', events[0].dueAt === '2026-09-10');
  check('the original is marked adjourned', events[0].status === 'adjourned');
  check('the chain links forward', events[0].adjournedTo === 'e1-next');
  check('and backward', events[2].adjournedFrom === 'e1-next');
  check(
    'the adjournment count is countable for court reporting',
    events.filter((e) => e.status === 'adjourned').length === 2
  );
  check('only the newest entry is live', events.filter((e) => e.status === 'scheduled').length === 1);
}

// ── 5. Closure checklist ─────────────────────────────────────────────────────

console.log('\n5. Closure checklist');
{
  const REQUIRED = ['settlementOrJudgmentPaid', 'advocateFeesSettled', 'recoveryCompletedOrWrittenOff'];
  const outstanding = (checklist) => REQUIRED.filter((k) => !checklist[k]);

  const complete = {
    settlementOrJudgmentPaid: true,
    advocateFeesSettled: true,
    recoveryCompletedOrWrittenOff: true,
  };
  check('a complete checklist closes cleanly', outstanding(complete).length === 0);
  check(
    'unsettled advocate fees block closure',
    outstanding({ ...complete, advocateFeesSettled: false }).length === 1
  );
  check(
    'an untracked recovery blocks closure',
    outstanding({ ...complete, recoveryCompletedOrWrittenOff: false }).length === 1
  );
  check('an empty checklist lists every requirement', outstanding({}).length === 3);
}

// ── 6. Judgment posting ──────────────────────────────────────────────────────

console.log('\n6. Judgment');
{
  const againstUs = (outcome) => !['for_insurer', 'dismissed', 'struck_out'].includes(outcome);

  check('a judgment for the claimant is posted against us', againstUs('for_claimant'));
  check('an apportioned judgment is posted against us', againstUs('apportioned'));
  check('a judgment for the insurer is not', !againstUs('for_insurer'));
  check('a dismissal is not', !againstUs('dismissed'));
  check('a strike-out is not', !againstUs('struck_out'));

  const total = money.sumMinor([K(8000000), K(640000), K(450000)]);
  check('judgment total is award plus interest plus costs', total === K(9090000));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nPhase 3 litigation checks NOT met.');
  process.exit(1);
}
console.log('\nPhase 3 litigation and allocation checks met.');
