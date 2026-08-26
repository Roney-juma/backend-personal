/**
 * Phase 1 exit checks for the third-party exposure engine.
 *
 *   node scripts/test-legal-exposure.js
 *
 * Covers the arithmetic that decides what the insurer pays — quantum,
 * apportionment, policy limits and aggregate erosion — plus the two
 * time-sensitive behaviours that are easy to get subtly wrong: month-end
 * limitation dates, and the reminder ladder's idempotency.
 *
 * No database and no test framework, matching the repo's existing script style.
 */

const exposure = require('../src/service/legalExposure.service');
const limitation = require('../src/service/limitation.service');
const reminder = require('../src/service/legalReminder.service');
const money = require('../src/utils/money');
const { TP_CLAIM_TYPES } = require('../src/constants/legal.constants');

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

// ── 1. Gross quantum ─────────────────────────────────────────────────────────

console.log('\n1. Gross quantum');
{
  check(
    'sums the heads when no overall assessment is given',
    exposure.grossOf({
      generalDamagesMinor: K(3000000),
      specialDamagesMinor: K(450000),
      lossOfEarningsMinor: K(600000),
    }).grossMinor === K(4050000)
  );

  check(
    'an explicit assessment overrides the sum of heads',
    exposure.grossOf({
      generalDamagesMinor: K(3000000),
      ourAssessmentMinor: K(2500000),
    }).grossMinor === K(2500000)
  );

  const demandOnly = exposure.grossOf({ demandedMinor: K(10000000) });
  check('falls back to the demand as a last resort', demandOnly.grossMinor === K(10000000));
  check(
    'and says so, because a demand is the other side\'s number',
    demandOnly.basis === 'demanded'
  );

  check('an unassessed claim is zero, not an error', exposure.grossOf({}).grossMinor === 0);
  check('and is flagged unassessed', exposure.grossOf({}).basis === 'unassessed');
}

// ── 2. Liability apportionment ───────────────────────────────────────────────

console.log('\n2. Liability apportionment');
{
  check(
    'a full 100% assessment is accepted',
    exposure.effectiveShare({ insuredSharePercent: 80, contributoryPercent: 20 }).sharePercent === 80
  );

  check(
    'our share is inferred from the others when not stated',
    exposure.effectiveShare({ contributoryPercent: 25, otherPartiesPercent: 15 }).sharePercent === 60
  );

  // The important one: shares that do not account for the whole of the fault
  // would silently understate exposure.
  let rejected = false;
  try {
    exposure.effectiveShare({ insuredSharePercent: 60, contributoryPercent: 20 });
  } catch {
    rejected = true;
  }
  check('shares that do not total 100% are rejected', rejected);

  check(
    'an unassessed claim is exposed at 100%, the prudent default',
    exposure.effectiveShare({}).sharePercent === 100
  );
  check('and is flagged unassessed', exposure.effectiveShare({}).assessed === false);

  check(
    'a one-decimal apportionment is accepted',
    exposure.effectiveShare({ insuredSharePercent: 82.5, contributoryPercent: 17.5 }).sharePercent === 82.5
  );
}

// ── 3. Limits ────────────────────────────────────────────────────────────────

console.log('\n3. Policy limits');
{
  check(
    'a property claim is capped by the property limit',
    exposure.limitHeadFor(TP_CLAIM_TYPES.PROPERTY_DAMAGE) === 'propertyDamageMinor'
  );
  check(
    'an injury claim is capped by the bodily-injury limit',
    exposure.limitHeadFor(TP_CLAIM_TYPES.BODILY_INJURY) === 'bodilyInjuryMinor'
  );
  check(
    'a fatal claim uses the bodily-injury limit',
    exposure.limitHeadFor(TP_CLAIM_TYPES.FATAL) === 'bodilyInjuryMinor'
  );

  // Property claim: 8m gross, 75% our fault = 6m, capped at a 5m PD limit.
  const capped = exposure.computeExposure({
    quantum: { ourAssessmentMinor: K(8000000) },
    liability: { insuredSharePercent: 75, contributoryPercent: 25 },
    claimType: TP_CLAIM_TYPES.PROPERTY_DAMAGE,
    limits: { propertyDamageMinor: K(5000000) },
  });

  check('apportionment is applied before the cap', capped.afterApportionmentMinor === K(6000000));
  check('the cap then bites', capped.cappedMinor === K(5000000));
  check('and the cap is reported', capped.limitApplied === true);
  check(
    'the uncovered excess is the insured\'s own exposure',
    capped.excessOfLimitMinor === K(1000000),
    `got ${money.formatMinor(capped.excessOfLimitMinor)}`
  );

  // Unlimited bodily-injury cover is common and must not cap.
  const uncapped = exposure.computeExposure({
    quantum: { ourAssessmentMinor: K(30000000) },
    liability: { insuredSharePercent: 100 },
    claimType: TP_CLAIM_TYPES.BODILY_INJURY,
    limits: { propertyDamageMinor: K(5000000), bodilyInjuryMinor: null },
  });
  check('unlimited injury cover does not cap', uncapped.cappedMinor === K(30000000));
  check('and reports no excess', uncapped.excessOfLimitMinor === 0);

  // The wrong-head bug: a big injury claim must not be capped by the small
  // property limit that happens to sit alongside it.
  check('an injury claim is not capped by the property limit', !uncapped.limitApplied);
}

// ── 4. Aggregate erosion across one accident ─────────────────────────────────

console.log('\n4. Aggregate limit erosion');
{
  // Four claimants, each individually modest, together over an aggregate.
  const claimants = [
    { cappedMinor: K(3000000) },
    { cappedMinor: K(2500000) },
    { cappedMinor: K(2000000) },
    { cappedMinor: K(4000000) },
  ];

  const erosion = exposure.computeAccidentErosion(claimants, { aggregateMinor: K(10000000) });

  check('total is the sum across claimants', erosion.totalExposureMinor === K(11500000));
  check('the aggregate limit is breached', erosion.limitEroded === true);
  check(
    'the excess over the aggregate is reported',
    erosion.excessOfLimitMinor === K(1500000),
    `got ${money.formatMinor(erosion.excessOfLimitMinor)}`
  );
  check('erosion is expressed as a percentage', erosion.erosionPercent === 115);
  check('no cover remains', erosion.remainingMinor === 0);
  check('claimant count is carried', erosion.claimantCount === 4);

  const within = exposure.computeAccidentErosion(claimants, { aggregateMinor: K(20000000) });
  check('an accident inside the aggregate is not flagged', within.limitEroded === false);
  check('remaining cover is reported', within.remainingMinor === K(8500000));

  const unlimited = exposure.computeAccidentErosion(claimants, {});
  check('no aggregate configured means no erosion', unlimited.limitEroded === false);
  check('and remaining is null rather than zero', unlimited.remainingMinor === null);
}

// ── 5. Limitation dates ──────────────────────────────────────────────────────

console.log('\n5. Limitation date arithmetic');
{
  const jan31 = new Date('2026-01-31T09:00:00Z');

  // The classic bug: 31 Jan + 1 month is not 31 February.
  const oneMonth = limitation.addMonths(jan31, 1);
  check(
    'month-end does not overflow into the next month',
    oneMonth.getMonth() === 1,
    `landed in month ${oneMonth.getMonth()} (${oneMonth.toDateString()})`
  );
  check('it clamps to the last day of the shorter month', oneMonth.getDate() === 28);

  const bi = limitation.addMonths(new Date('2026-05-15T00:00:00Z'), 72);
  check('bodily injury at 72 months lands 6 years out', bi.getFullYear() === 2032);

  const pd = limitation.addMonths(new Date('2026-05-15T00:00:00Z'), 36);
  check('property damage at 36 months lands 3 years out', pd.getFullYear() === 2029);

  check('limitation runs to the end of the day', bi.getHours() === 23 && bi.getMinutes() === 59);

  // Leap year, the other date bug.
  const leap = limitation.addMonths(new Date('2028-02-29T00:00:00Z'), 12);
  check('29 February clamps to 28 February the following year', leap.getDate() === 28 && leap.getMonth() === 1);

  const remaining = limitation.daysRemaining(
    { limitation: { expiresAt: new Date(Date.now() + 10 * 86400000) } }
  );
  check('days remaining is computed', remaining === 10, `got ${remaining}`);

  check(
    'an extension supersedes the original expiry',
    limitation.daysRemaining({
      limitation: {
        expiresAt: new Date(Date.now() + 5 * 86400000),
        extendedTo: new Date(Date.now() + 40 * 86400000),
      },
    }) === 40
  );

  check('a claim with no clock returns null, not zero', limitation.daysRemaining({}) === null);
}

// ── 6. Reminder ladder ───────────────────────────────────────────────────────

console.log('\n6. Reminder ladder');
{
  const now = new Date('2026-08-21T08:00:00Z');
  const due = (days) => new Date(now.getTime() + days * 86400000);

  const event = (daysOut, sent = []) => ({
    dueAt: due(daysOut),
    reminderOffsets: [30, 14, 7, 2, 0],
    remindersSent: sent.map((offsetDays) => ({ offsetDays })),
  });

  check(
    'nothing fires while the deadline is far off',
    reminder.dueOffsets(event(45), now).length === 0
  );
  check(
    'the 30-day offset fires at 30 days',
    reminder.dueOffsets(event(30), now).includes(30)
  );

  // The catch-up case: a claim registered 8 days before its deadline must still
  // warn. Offsets it has already passed are due, not skipped.
  const lateRegistration = reminder.dueOffsets(event(8), now);
  check('a late-registered deadline reports every passed offset', lateRegistration.length === 2);
  check('including the tightest one that applies', lateRegistration.includes(14) && lateRegistration.includes(30));

  check(
    'an offset already sent does not fire again',
    !reminder.dueOffsets(event(7, [30, 14, 7]), now).includes(7)
  );
  check(
    'but an unsent tighter offset still does',
    reminder.dueOffsets(event(2, [30, 14, 7]), now).includes(2)
  );
  check(
    'nothing fires once the deadline has passed — that is the overdue sweep',
    reminder.dueOffsets(event(-3), now).length === 0
  );
  check(
    'a fully reminded event is quiet',
    reminder.dueOffsets(event(0, [30, 14, 7, 2, 0]), now).length === 0
  );
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nPhase 1 exposure checks NOT met.');
  process.exit(1);
}
console.log('\nPhase 1 exposure and limitation checks met.');
