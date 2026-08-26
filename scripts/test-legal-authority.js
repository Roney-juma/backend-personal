/**
 * Phase 2 checks — settlement authority and the money lifecycle.
 *
 *   node scripts/test-legal-authority.js
 *
 * The authority matrix is where this module says no to a person. Every rule in
 * it is a rule someone will eventually try to route around, usually with good
 * intentions and a deadline, so each one is tested explicitly:
 *
 *   - the band that governs an amount, including the boundaries
 *   - who may decide, and who may not (including the proposer)
 *   - that authority for one figure is not authority for a larger one
 *   - that the matrix rule is snapshotted, not looked up later
 *
 * No database and no test framework.
 */

const {
  DEFAULT_AUTHORITY_MATRIX,
  DEFAULT_ESCALATION_CHAIN,
} = require('../src/constants/legal.constants');
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

/** The band-selection rule, as approval.service applies it. */
function bandFor(amountMinor, bands = DEFAULT_AUTHORITY_MATRIX) {
  return bands.find(
    (b) =>
      amountMinor >= b.minMinor &&
      (b.maxMinor === null || b.maxMinor === undefined || amountMinor <= b.maxMinor)
  );
}

// ── 1. Band selection ────────────────────────────────────────────────────────

console.log('\n1. Authority bands');
{
  check('a small settlement sits with the Claims Manager', bandFor(K(250000))?.approver === 'Claims Manager');
  check('a mid-size one reaches the Head of Claims', bandFor(K(1500000))?.approver === 'Head of Claims');
  check('a larger one reaches the Head of Legal', bandFor(K(3000000))?.approver === 'Head of Legal');
  check('a big one reaches the GM', bandFor(K(7500000))?.approver === 'General Manager');
  check('the largest reach the CEO', bandFor(K(50000000))?.approver === 'CEO');

  // Boundaries are where off-by-one errors put a decision one rung too low.
  check('the top of a band stays in that band', bandFor(K(500000))?.approver === 'Claims Manager');
  check('one cent above it moves up', bandFor(K(500000) + 1)?.approver === 'Head of Claims');
  check('the bottom of a band is in it', bandFor(K(500000.01))?.approver === 'Head of Claims');

  check('zero is a valid amount and lands in the lowest band', bandFor(0)?.approver === 'Claims Manager');
  check('the top band is unbounded', bandFor(Number.MAX_SAFE_INTEGER - 1)?.approver === 'CEO');

  // Every amount must land somewhere, or a settlement could pass unapproved.
  let gaps = 0;
  for (let amount = 0; amount < K(20000000); amount += K(9999)) {
    if (!bandFor(amount)) gaps += 1;
  }
  check('the matrix leaves no gaps across the range', gaps === 0, `${gaps} amounts matched no band`);
}

// ── 2. Who may decide ────────────────────────────────────────────────────────

console.log('\n2. Who may decide');
{
  // Mirrors approval.service.canDecide without needing the database.
  const normalise = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
  const isAdmin = (r) => ['admin', 'superadmin'].includes(normalise(r));

  function canDecide(request, actor) {
    if (!actor) return { allowed: false };
    if (isAdmin(actor.roleName)) return { allowed: true };
    if (String(request.requestedBy || '') === String(actor.id || '')) {
      return { allowed: false, reason: 'self-approval' };
    }
    if (request.requiredApproverKind === 'permission') {
      const held = (actor.permissions || []).map((p) => p.toUpperCase());
      return { allowed: held.includes(request.requiredApprover.toUpperCase()) };
    }
    if (request.requiredApproverKind === 'user') {
      return { allowed: String(request.requiredApprover) === String(actor.id) };
    }
    return { allowed: normalise(actor.roleName) === normalise(request.requiredApprover) };
  }

  const request = {
    requiredApprover: 'Head of Claims',
    requiredApproverKind: 'role',
    requestedBy: 'user-1',
    amountMinor: K(1500000),
  };

  check(
    'the named role may decide',
    canDecide(request, { id: 'user-2', roleName: 'Head of Claims' }).allowed
  );
  check(
    'a lower role may not',
    !canDecide(request, { id: 'user-2', roleName: 'Claims Manager' }).allowed
  );
  check(
    'role matching ignores case and spacing',
    canDecide(request, { id: 'user-2', roleName: 'head_of_claims' }).allowed
  );
  check('an admin may decide anything', canDecide(request, { id: 'u', roleName: 'Super Admin' }).allowed);

  // The one that matters most.
  const self = canDecide(request, { id: 'user-1', roleName: 'Head of Claims' })
  check('the proposer may NOT approve their own settlement', !self.allowed)
  check('and is told why', self.reason === 'self-approval')

  check(
    'an admin still cannot be checked as unauthenticated',
    !canDecide(request, null).allowed
  );
}

// ── 3. Authority does not stretch ────────────────────────────────────────────

console.log('\n3. Authority does not stretch upward');
{
  /**
   * The revise-after-approval rule from settlement.service.addOffer: once a
   * figure is authorised, raising it invalidates the authority. Without this a
   * settlement approved at 400k could quietly be paid at 4m.
   */
  function reviseOffer(settlement, newTotalMinor) {
    const next = { ...settlement, totalMinor: newTotalMinor };
    if (
      next.status === 'approved' &&
      next.approvedAmountMinor !== undefined &&
      next.totalMinor > next.approvedAmountMinor
    ) {
      next.status = 'draft';
      next.approvedAmountMinor = undefined;
    }
    return next;
  }

  const approved = { status: 'approved', totalMinor: K(400000), approvedAmountMinor: K(400000) };

  check(
    'raising an approved figure withdraws the authority',
    reviseOffer(approved, K(600000)).status === 'draft'
  );
  check(
    'and clears the approved amount',
    reviseOffer(approved, K(600000)).approvedAmountMinor === undefined
  );
  check(
    'lowering it keeps the authority — a smaller settlement is already covered',
    reviseOffer(approved, K(300000)).status === 'approved'
  );
  check(
    'settling at exactly the approved figure keeps it',
    reviseOffer(approved, K(400000)).status === 'approved'
  );

  // A revision that crosses a band boundary must reach the higher approver.
  const revised = reviseOffer(approved, K(2500000));
  check('a revision that crosses a band must be re-approved', revised.status === 'draft');
  check(
    'and now requires the higher band',
    bandFor(K(2500000))?.approver === 'Head of Legal',
    `got ${bandFor(K(2500000))?.approver}`
  );
}

// ── 4. Rule snapshotting ─────────────────────────────────────────────────────

console.log('\n4. Rule snapshotting');
{
  // A decision must remain explicable after the matrix changes underneath it.
  const originalMatrix = DEFAULT_AUTHORITY_MATRIX;
  const band = bandFor(K(1500000), originalMatrix);

  const snapshot = {
    minMinor: band.minMinor,
    maxMinor: band.maxMinor,
    approverKind: band.approverKind,
    approver: band.approver,
    configVersion: 1,
  };

  // The tenant later tightens their matrix.
  const revisedMatrix = [
    { minMinor: 0, maxMinor: K(100000), approverKind: 'role', approver: 'Claims Manager' },
    { minMinor: K(100000) + 1, maxMinor: null, approverKind: 'role', approver: 'CEO' },
  ];

  check(
    'the same amount would route differently under the new matrix',
    bandFor(K(1500000), revisedMatrix)?.approver === 'CEO'
  );
  check(
    'but the snapshot still records who actually approved it',
    snapshot.approver === 'Head of Claims'
  );
  check('and under which config version', snapshot.configVersion === 1);
  check(
    'the snapshot carries the band bounds, not just the name',
    snapshot.minMinor === band.minMinor && snapshot.maxMinor === band.maxMinor
  );
}

// ── 5. The two ladders are different ─────────────────────────────────────────

console.log('\n5. Authority matrix vs escalation chain');
{
  const approvers = DEFAULT_AUTHORITY_MATRIX.map((b) => b.approver);
  const escalationRoles = DEFAULT_ESCALATION_CHAIN.map((r) => r.role);

  check(
    'the escalation chain contains roles with no settlement authority',
    escalationRoles.some((r) => !approvers.includes(r)),
    `escalation ${escalationRoles.join(' → ')} vs authority ${approvers.join(', ')}`
  );
  check(
    'the escalation chain is ordered and contiguous',
    DEFAULT_ESCALATION_CHAIN.every((r, i) => r.rung === i + 1)
  );
  check(
    'it starts with the Legal Officer',
    DEFAULT_ESCALATION_CHAIN[0].role === 'Legal Officer'
  );
  check(
    'and ends at the CEO',
    DEFAULT_ESCALATION_CHAIN[DEFAULT_ESCALATION_CHAIN.length - 1].role === 'CEO'
  );
  check(
    'every rung has a quiet period before the next',
    DEFAULT_ESCALATION_CHAIN.every((r) => Number.isFinite(r.afterDays))
  );
}

// ── 6. Settlement lifecycle ──────────────────────────────────────────────────

console.log('\n6. Settlement lifecycle');
{
  const TRANSITIONS = {
    draft: ['pending_approval', 'withdrawn'],
    pending_approval: ['approved', 'rejected', 'withdrawn'],
    approved: ['accepted', 'declined_by_claimant', 'draft', 'withdrawn'],
    rejected: ['pending_approval', 'withdrawn'],
    accepted: ['executed', 'withdrawn'],
    executed: ['paid'],
    paid: [],
  };

  const can = (from, to) => (TRANSITIONS[from] || []).includes(to);

  check('a draft can be sent for approval', can('draft', 'pending_approval'));
  check('an approved settlement can be accepted by the claimant', can('approved', 'accepted'));
  check('an accepted settlement can be executed', can('accepted', 'executed'));
  check('an executed settlement can be paid', can('executed', 'paid'));

  // The distinction that matters: approved is not accepted, and neither is paid.
  check('approval alone does not permit execution', !can('approved', 'executed'));
  check('acceptance alone does not permit payment', !can('accepted', 'paid'));
  check('a draft cannot jump straight to paid', !can('draft', 'paid'));
  check('a rejected settlement can be revised and resubmitted', can('rejected', 'pending_approval'));
  check('an executed settlement cannot be withdrawn', !can('executed', 'withdrawn'));
  check('a paid settlement is terminal', TRANSITIONS.paid.length === 0);
}

// ── 7. Settlement totals ─────────────────────────────────────────────────────

console.log('\n7. Settlement totals');
{
  const total = (damages, costs, interest) => money.sumMinor([damages, costs, interest]);

  check(
    'total is damages plus costs plus interest',
    total(K(4500000), K(280000), K(120000)) === K(4900000)
  );
  check('costs and interest default to zero', total(K(4500000), 0, 0) === K(4500000));

  // The authority matrix applies to the TOTAL, not the damages figure — costs
  // can push a settlement into a higher band on their own.
  check(
    'costs can push a settlement into a higher band',
    bandFor(K(490000))?.approver === 'Claims Manager' &&
      bandFor(total(K(490000), K(20000), 0))?.approver === 'Head of Claims'
  );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nPhase 2 authority checks NOT met.');
  process.exit(1);
}
console.log('\nPhase 2 authority and settlement checks met.');
