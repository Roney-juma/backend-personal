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

const { canView, downloadFilename } = require('../src/service/legalDocument.service');
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

// ── 6b. Download naming ──────────────────────────────────────────────────────

/**
 * A document saved without its extension is a file the operating system will
 * not open, which the user experiences as a corrupt download rather than a
 * naming bug — so the extension is not cosmetic.
 */
console.log('\n6b. What a download is saved as');
{
  const doc = (over = {}) => ({
    title: 'Witness statement',
    storageKey: 'legal/c1/1712_ab_Witness Statement.pdf',
    mimeType: 'application/pdf',
    ...over,
  });

  check(
    'the extension comes from the stored file, not the title',
    downloadFilename(doc()).name === 'Witness statement.pdf',
    downloadFilename(doc()).name
  );
  check(
    'a key with no extension falls back to the mime type',
    downloadFilename(doc({ storageKey: 'legal/c1/1712_ab_defence' })).name === 'Witness statement.pdf'
  );
  check(
    'a title that already carries the extension does not double it',
    downloadFilename(doc({ title: 'Bundle.pdf' })).name === 'Bundle.pdf'
  );
  check(
    'characters illegal in a filename are replaced',
    !/[\\/:*?"<>|]/.test(downloadFilename(doc({ title: 'Ruling 12/08 "final"' })).name)
  );
  check(
    'a space stays a space rather than becoming %20',
    !downloadFilename(doc()).name.includes('%20')
  );

  const swahili = downloadFilename(doc({ title: 'Mahakama — hukumu' }));
  check('non-ASCII survives in the RFC 5987 name', swahili.name.includes('—'));
  check(
    'and is stripped from the Latin-1 fallback',
    // eslint-disable-next-line no-control-regex
    !/[^\x20-\x7E]/.test(swahili.ascii)
  );
  check(
    'an untitled document still gets a name',
    downloadFilename(doc({ title: '' })).name === 'document.pdf',
    downloadFilename(doc({ title: '' })).name
  );
}

// ── 7. Panel credentials ─────────────────────────────────────────────────────

/**
 * Adding an advocate now issues portal access and emails it. The risk in that
 * is the password reaching a channel it should not, or the account being left
 * unusable because the mail failed — so both are checked here.
 *
 * Still no database: the model and the notifier are stubbed in place.
 */
async function credentialChecks() {
  console.log('\n7. Panel credentials');

  // Stub the two underlying notifiers in the require cache BEFORE legalNotify
  // loads, exactly as test-legal-referral does — legalNotify captures direct
  // references to both, and notification.service reads the JWT keypair at
  // import time. The real legalNotify then runs, so the channel split being
  // asserted below is the one production uses rather than a stub of it.
  const inApp = [];
  const emails = [];

  const notificationPath = require.resolve('../src/service/notification.service');
  require.cache[notificationPath] = {
    id: notificationPath, filename: notificationPath, loaded: true,
    exports: { createAndEmit: async (payload) => { inApp.push(payload); return payload; } },
  };
  const emailPath = require.resolve('../src/service/email.service');
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: {
      sendEmailNotification: async (to, subject, body, options) => {
        emails.push({ to, subject, body, options });
        return true;
      },
    },
  };

  const Advocate = require('../src/models/advocate.model');
  const advocateService = require('../src/service/advocate.service');

  let saved = null;

  Advocate.findOne = async () => null;
  Advocate.create = async (doc) => {
    saved = { ...doc, _id: 'adv-test' };
    return saved;
  };
  // sendToAdvocate re-reads the advocate to resolve its contact details.
  Advocate.findById = () => ({
    select: () => ({ lean: async () => ({ _id: 'adv-test', name: saved?.name, email: saved?.email, phone: saved?.phone }) }),
  });

  const details = {
    company: 'c1',
    name: 'A. Counsel',
    email: 'Counsel@Firm.co.ke',
    phone: '0700000000',
    firm: { name: 'Counsel & Co' },
  };

  const advocate = await advocateService.create({ ...details });
  // create() does not await the send, so let the microtask queue drain.
  await new Promise((r) => setImmediate(r));

  check('a new advocate is given portal access', saved?.active_account === true);
  check('the password is stored hashed, never in the clear', Boolean(saved?.password) && !String(saved.password).includes('#'));
  check('they must change it on first sign-in', saved?.mustChangePassword === true);
  check('the email is normalised to lower case', saved?.email === 'counsel@firm.co.ke');
  check(
    'adding to the panel does not approve for instructions',
    saved?.approved === false,
    'access to the portal is not clearance to be instructed'
  );

  check('exactly one email is sent', emails.length === 1, `sent ${emails.length}`);
  check('it goes to the advocate', emails[0]?.to === 'counsel@firm.co.ke');

  const tempPassword = (emails[0]?.body.match(/Temporary password:\s*(\S+)/) || [])[1];
  check('the email carries the temporary password', Boolean(tempPassword));
  check('the email carries the username', emails[0]?.body.includes('counsel@firm.co.ke'));

  // The password opens privileged case files; a copy in a chat backup is a
  // disclosure risk, so this channel split is the point of the whole path.
  check('the password is not mirrored to WhatsApp', emails[0]?.options?.whatsapp === false);

  check('an in-app notice is sent as well', inApp.length === 1, `sent ${inApp.length}`);
  check(
    'the in-app notice carries no password',
    Boolean(tempPassword) && !String(inApp[0]?.content || '').includes(tempPassword),
    inApp[0]?.content
  );

  // A bulk panel import must not mail everyone at once.
  emails.length = 0;
  inApp.length = 0;
  await advocateService.create({ ...details, email: 'quiet@firm.co.ke', sendCredentials: false });
  await new Promise((r) => setImmediate(r));
  check('an import can add an advocate without mailing them', emails.length === 0 && inApp.length === 0);
  check('that advocate has no portal access yet', saved?.active_account !== true);
  check('sendCredentials is not persisted onto the record', !('sendCredentials' in (saved || {})));

  // The generated password has to survive being read off a screen and typed.
  // Checked over a sample rather than one draw: the first version of this put
  // the ambiguous glyphs only in a random numeric suffix, so a single-draw
  // check passed most of the time and failed roughly one run in three.
  const sample = Array.from({ length: 200 }, () => advocateService.generateTempPassword());
  check('a generated password meets the 8-character floor', sample.every((p) => p.length >= 8));
  check(
    'no generated password contains a glyph that is misread',
    sample.every((p) => !/[0O1lI]/.test(p)),
    sample.find((p) => /[0O1lI]/.test(p))
  );
  check('each carries a digit and a symbol', sample.every((p) => /[2-9]/.test(p) && /#/.test(p)));
  check('every advocate gets a different one', new Set(sample).size === 200);

  check('the created advocate is returned to the caller', Boolean(advocate));

  // ── Removal ────────────────────────────────────────────────────────────────
  const LegalCase = require('../src/models/legalCase.model');

  const panelMember = {
    _id: 'adv-test',
    name: 'A. Counsel',
    email: 'counsel@firm.co.ke',
    firm: { name: 'Counsel & Co' },
    active: true,
    active_account: true,
    password: 'hashed',
    mfaSecret: 'secret',
    fcmToken: 'token',
    save: async function save() { return this; },
  };
  Advocate.findById = async () => panelMember;

  let softDeleted = null;
  Advocate.softDeleteById = async (id) => { softDeleted = id; return panelMember; };

  // Counsel with live litigation must not simply vanish.
  LegalCase.countDocuments = async () => 2;
  let refusal = null;
  try {
    await advocateService.remove('adv-test');
  } catch (err) {
    refusal = err;
  }
  check('an advocate holding open matters cannot be deleted', refusal?.statusCode === 409);
  check('the refusal says how many matters are open', /\b2\b/.test(refusal?.message || ''), refusal?.message);
  check('and points to suspension instead', /suspend/i.test(refusal?.message || ''));
  check('nothing was deleted', softDeleted === null);
  check('portal access was not revoked by the failed attempt', panelMember.active_account === true);

  // With nothing live, removal proceeds.
  LegalCase.countDocuments = async () => 0;
  const removed = await advocateService.remove('adv-test');

  check('an advocate with no open matters is removed', softDeleted === 'adv-test');
  check('the removal is a soft delete, not a destroy', Boolean(removed.advocate));
  check('portal access is revoked', panelMember.active_account === false);
  check('the stored password is cleared', panelMember.password === undefined);
  check('the MFA secret is cleared', panelMember.mfaSecret === undefined);
  check('they are excluded from allocation', panelMember.active === false);

  Advocate.findById = async () => null;
  let missing = null;
  try {
    await advocateService.remove('gone');
  } catch (err) {
    missing = err;
  }
  check('deleting an advocate that does not exist is a 404', missing?.statusCode === 404);
}

credentialChecks()
  .catch((err) => {
    failed += 1;
    console.log(`  FAIL panel credentials threw — ${err.message}`);
  })
  .then(() => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\nPhase 3 litigation checks NOT met.');
      process.exit(1);
    }
    console.log('\nPhase 3 litigation and allocation checks met.');
  });
