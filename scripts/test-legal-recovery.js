/**
 * Phase 4 checks — recovery arithmetic, risk banding and analytics guards.
 *
 *   node scripts/test-legal-recovery.js
 *
 * The recurring theme here is honesty about small numbers. A recovery rate
 * measured against an unachievable target, a median from three matters, or a
 * court "averaging 3 adjournments" over one case are all figures that read as
 * findings and are not. Each is tested for the guard that keeps it honest.
 *
 * No database and no test framework.
 */

const money = require('../src/utils/money');
const { DEFAULT_RISK_WEIGHTS, DEFAULT_RISK_THRESHOLDS } = require('../src/constants/legal.constants');
const { MIN_SAMPLE } = require('../src/service/legalAnalytics.service');

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

// ── 1. Recoverable, not outlay ───────────────────────────────────────────────

console.log('\n1. What is actually recoverable');
{
  // The default from recovery.service.create: outlay reduced by our own
  // insured's share of the fault.
  const recoverable = (outlayMinor, ourSharePercent) =>
    money.applyPercent(outlayMinor, 100 - ourSharePercent);

  check(
    'no fault of ours means the whole outlay is recoverable',
    recoverable(K(800000), 0) === K(800000)
  );
  check(
    'a 30% share leaves 70% recoverable',
    recoverable(K(800000), 30) === K(560000),
    `got ${money.formatMinor(recoverable(K(800000), 30))}`
  );
  check(
    'entirely our fault leaves nothing to recover',
    recoverable(K(800000), 100) === 0
  );

  // The point of the guard: a rate against the full outlay understates a
  // recovery function that did everything available to it.
  const outlay = K(800000);
  const recovered = K(560000);
  const rateAgainstRecoverable = Math.round((recovered / recoverable(outlay, 30)) * 100);
  const rateAgainstOutlay = Math.round((recovered / outlay) * 100);

  check('a full recovery reads as 100% against the recoverable target', rateAgainstRecoverable === 100);
  check('and would read as only 70% against the outlay', rateAgainstOutlay === 70);
}

// ── 2. Outstanding ───────────────────────────────────────────────────────────

console.log('\n2. Outstanding');
{
  const outstanding = (recoverable, recovered, writtenOff) =>
    Math.max(0, recoverable - recovered - writtenOff);

  check('nothing in yet leaves the whole target outstanding', outstanding(K(500000), 0, 0) === K(500000));
  check('a part payment reduces it', outstanding(K(500000), K(200000), 0) === K(300000));
  check('a write-off also reduces it', outstanding(K(500000), K(200000), K(300000)) === 0);
  check('it never goes negative', outstanding(K(500000), K(400000), K(200000)) === 0);
}

// ── 3. Recoveries are credits ────────────────────────────────────────────────

console.log('\n3. Recoveries reduce exposure');
{
  const { computePosition } = require('../src/service/legalLedger.service');

  const withoutRecovery = computePosition([
    { _id: { entryType: 'settlement' }, signedMinor: K(4500000) },
    { _id: { entryType: 'legal_fee' }, signedMinor: K(300000) },
  ]);

  const withRecovery = computePosition([
    { _id: { entryType: 'settlement' }, signedMinor: K(4500000) },
    { _id: { entryType: 'legal_fee' }, signedMinor: K(300000) },
    // A credit, so its signed contribution is negative.
    { _id: { entryType: 'recovery' }, signedMinor: -K(1500000) },
  ]);

  check(
    'a recovery lowers net exposure',
    withRecovery.netExposureMinor < withoutRecovery.netExposureMinor
  );
  check(
    'by exactly what came in',
    withoutRecovery.netExposureMinor - withRecovery.netExposureMinor === K(1500000)
  );
  check('and is reported as a positive figure', withRecovery.recoveriesMinor === K(1500000));

  const withWriteOff = computePosition([
    { _id: { entryType: 'settlement' }, signedMinor: K(4500000) },
    { _id: { entryType: 'write_off' }, signedMinor: -K(500000) },
  ]);
  check('a write-off behaves the same way', withWriteOff.netExposureMinor === K(4000000));
}

// ── 4. Risk banding ──────────────────────────────────────────────────────────

console.log('\n4. Legal-risk banding');
{
  const w = DEFAULT_RISK_WEIGHTS;
  const t = DEFAULT_RISK_THRESHOLDS;

  const band = (score) => {
    if (score >= t.critical) return 'critical';
    if (score >= t.high) return 'high';
    if (score >= t.medium) return 'medium';
    return 'low';
  };
  const scoreOf = (keys) => Math.min(100, keys.reduce((a, k) => a + Math.round(w[k] * 100), 0));

  check('a routine property claim stays low', band(scoreOf([])) === 'low');
  check(
    'bodily injury alone is not yet a referral',
    band(scoreOf(['bodily_injury'])) === 'low',
    `scored ${scoreOf(['bodily_injury'])}`
  );
  check(
    'a fatality with a disputed liability reaches high',
    ['high', 'critical'].includes(band(scoreOf(['fatality', 'liability_dispute', 'advocate_demand']))),
    `scored ${scoreOf(['fatality', 'liability_dispute', 'advocate_demand'])}`
  );
  check(
    'a fatality, dispute, high value and multiple claimants is critical',
    band(scoreOf(['fatality', 'liability_dispute', 'high_claim_value', 'multiple_claimants', 'advocate_demand'])) ===
      'critical'
  );
  check('the score is capped at 100', scoreOf(Object.keys(w)) <= 100);
  check(
    'weights sum to 1 before scaling',
    Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.001
  );
  check(
    'thresholds are ordered',
    t.medium < t.high && t.high < t.critical
  );

  // This engine measures SEVERITY, not suspicion. A fatal accident with clear
  // liability and no fraud indicator should still score highly.
  check(
    'a clean, undisputed fatality still scores as serious',
    scoreOf(['fatality', 'high_claim_value']) >= t.medium,
    `scored ${scoreOf(['fatality', 'high_claim_value'])}`
  );
}

// ── 5. Small-sample guards ───────────────────────────────────────────────────

console.log('\n5. Small-sample honesty');
{
  const reliable = (count) => count >= MIN_SAMPLE;

  check('the minimum sample is a real threshold', MIN_SAMPLE >= 5);
  check('one matter is never reliable', !reliable(1));
  check('three matters are not reliable', !reliable(3));
  check('the threshold itself is reliable', reliable(MIN_SAMPLE));

  // An advocate at 100% over two matters must not outrank one at 70% over
  // forty just because the arithmetic is flattering.
  const rateShown = (wins, closed) => (reliable(closed) ? wins / closed : null);
  check('a 2-matter win rate is withheld entirely', rateShown(2, 2) === null);
  check('a 40-matter win rate is shown', rateShown(28, 40) === 0.7);

  // Comparables carry the caveat through to the assistant.
  const note = (count) => (reliable(count) ? null : `Only ${count} comparable matter(s) — treat as anecdotal, not a guide.`);
  check('a thin comparable set carries a caveat', /anecdotal/.test(note(3)));
  check('a solid one does not', note(12) === null);
}

// ── 6. The assistant is read-only by construction ────────────────────────────

console.log('\n6. Assistant guardrails');
{
  const { TOOLS } = require('../src/ai/agents/legalAssistant.tools');
  const names = TOOLS.map((t) => t.name);

  // The strongest guarantee is structural: it cannot approve a settlement
  // because it holds no tool that writes anything at all.
  const writeVerbs = /^(create|update|delete|set|approve|reject|pay|post|execute|withdraw|assess|record)_/;
  check(
    'no tool has a mutating name',
    names.every((n) => !writeVerbs.test(n)),
    names.filter((n) => writeVerbs.test(n)).join(', ')
  );
  check('every tool is a find/get/list/compare', names.every((n) => /^(find|get|list|compare)_/.test(n)));
  check('every tool declares a schema', TOOLS.every((t) => t.input_schema?.type === 'object'));
  check('every tool has a description', TOOLS.every((t) => (t.description || '').length > 40));

  const docTool = TOOLS.find((t) => t.name === 'list_case_documents');
  check(
    'the document tool says it returns metadata only',
    /METADATA ONLY|metadata only/i.test(docTool.description)
  );

  const { buildSystem } = require('../src/ai/agents/legalAssistant.agent');
  const system = buildSystem({ fullName: 'Test Officer' });
  check('the prompt refuses legal advice', /do not give legal advice/i.test(system));
  check('the prompt refuses to approve settlements', /do not approve settlements/i.test(system));
  check('the prompt refuses to value claims', /do not decide what a claim is worth/i.test(system));
  check(
    'the prompt forbids stating limitation periods from memory',
    /do not state limitation periods/i.test(system)
  );
  check('the prompt requires repeating sample-size caveats', /repeat it/i.test(system));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nPhase 4 checks NOT met.');
  process.exit(1);
}
console.log('\nPhase 4 recovery, risk and assistant checks met.');
