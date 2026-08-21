/**
 * Verify the referral gateway and the notification composition.
 *
 *   node scripts/test-legal-referral.js
 *
 * Two things are checked here, and both are the kind of defect that looks fine
 * in review and only shows up in production:
 *
 *   1. Every trigger a tenant can enable actually has an evaluator behind it.
 *      A configured trigger with no evaluator fails silently — the sweep runs,
 *      reports zero, and the insurer believes their rules are working.
 *
 *   2. A legal notification produces exactly ONE WhatsApp message. The two
 *      underlying services both send WhatsApp (createAndEmit resolves the number
 *      itself; sendEmailNotification mirrors), so calling both — which is what
 *      "notify by email and WhatsApp" naively means — double-sends. Recipients
 *      would get two identical messages for every court date.
 *
 * No database required: the referral trigger evaluators are pure functions of a
 * claim-shaped object, and the notification services are stubbed.
 */

require('dotenv').config();

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

async function main() {
  // Stub first. legalNotify captures direct references to both notification
  // services at require time, so swapping the cache afterwards would leave it
  // holding the real ones — and the WhatsApp assertions would silently pass
  // against nothing.
  const sent = stubNotificationServices();

  const { DEFAULT_REFERRAL_TRIGGERS } = require('../src/constants/legal.constants');
  const referral = require('../src/service/legalReferral.service');

  // ── 1. Trigger catalogue ───────────────────────────────────────────────────
  console.log('\n1. Referral triggers');

  check(
    'the seeded defaults are not empty',
    DEFAULT_REFERRAL_TRIGGERS.length > 0,
    'a tenant with no triggers never auto-refers anything'
  );

  const orphans = DEFAULT_REFERRAL_TRIGGERS.filter((t) => !referral.TRIGGERS[t.code]);
  check(
    'every default trigger has an evaluator',
    orphans.length === 0,
    orphans.map((t) => t.code).join(', ')
  );

  const autoRefer = DEFAULT_REFERRAL_TRIGGERS.filter((t) => t.autoRefer);
  check(
    'at least one default trigger actually refers rather than only advising',
    autoRefer.length > 0
  );
  check(
    'not every trigger auto-refers — some are advisory',
    autoRefer.length < DEFAULT_REFERRAL_TRIGGERS.length,
    'a config where everything auto-refers floods the queue'
  );

  // A fatality must never be merely advisory. This is the one the spec makes
  // mandatory, and it is the one a mis-edit would quietly downgrade.
  const fatal = DEFAULT_REFERRAL_TRIGGERS.find((t) => t.code === 'fatal_accident');
  check('a fatal accident is a default trigger', Boolean(fatal));
  check('a fatal accident auto-refers by default', fatal?.autoRefer === true);

  const codes = DEFAULT_REFERRAL_TRIGGERS.map((t) => t.code);
  check('no trigger is listed twice', new Set(codes).size === codes.length);

  // ── 2. Evaluators fire on the right shapes ─────────────────────────────────
  console.log('\n2. Trigger evaluation');

  const config = { referralTriggers: DEFAULT_REFERRAL_TRIGGERS };

  // An own-damage claim with no third party claiming against it: nothing here
  // is a legal matter, and a config that refers it is a config nobody trusts.
  const quietFired = await runTriggers(
    referral,
    { claim: { _id: 'c1', status: 'Approved' }, exposures: [] },
    config
  );
  check(
    'an ordinary own-damage claim fires nothing',
    quietFired.length === 0,
    quietFired.map((f) => f.code).join(', ')
  );

  const fatalFired = await runTriggers(
    referral,
    {
      claim: { _id: 'c2', status: 'Approved' },
      exposures: [{ claimType: 'fatal', injury: { deceased: true } }],
    },
    config
  );
  check(
    'a fatality fires the fatal_accident trigger',
    fatalFired.some((f) => f.code === 'fatal_accident'),
    fatalFired.map((f) => f.code).join(', ') || 'nothing fired'
  );
  check(
    'the fatality trigger is marked auto-refer when it fires',
    fatalFired.find((f) => f.code === 'fatal_accident')?.autoRefer === true
  );

  // ── 3. Notification composition ────────────────────────────────────────────
  console.log('\n3. Notification channels');

  const notify = require('../src/service/legalNotify.service');

  sent.reset();
  await notify.send({
    to: { id: 'u1', type: 'admin', email: 'officer@example.com', name: 'Officer' },
    type: 'legal_test',
    title: 'Return date',
    body: 'Milimani CMCC on Tuesday.',
  });

  check('in-app is sent', sent.inApp.length === 1);
  check('email is sent', sent.email.length === 1);
  check(
    'WhatsApp is sent exactly once',
    sent.whatsappSends() === 1,
    `counted ${sent.whatsappSends()} — the email mirror and createAndEmit both fired`
  );

  sent.reset();
  await notify.send({
    to: { email: 'counsel@example.com', name: 'Counsel' },
    type: 'legal_test',
    title: 'Instructions',
    body: 'Please enter appearance.',
  });
  check('an email-only recipient still gets the email', sent.email.length === 1);
  check(
    'an email-only recipient gets one WhatsApp via the mirror',
    sent.whatsappSends() === 1,
    'with no in-app send, the email mirror must not be suppressed'
  );

  sent.reset();
  await notify.send({
    to: { id: 'a1', type: 'advocate', email: 'counsel@example.com' },
    type: 'legal_portal_access',
    title: 'Password',
    body: 'Temporary password: hunter2',
    channels: { inApp: false, whatsapp: false, push: false, email: true },
  });
  check('a credentials email sends no in-app notification', sent.inApp.length === 0);
  check(
    'a credentials email sends no WhatsApp',
    sent.whatsappSends() === 0,
    'a password must not land in a chat backup'
  );

  sent.reset();
  await notify.send({ to: {}, type: 'legal_test', title: 't', body: 'b' });
  check('a recipient with neither id nor email sends nothing', sent.inApp.length + sent.email.length === 0);

  // ── 4. Templates ───────────────────────────────────────────────────────────
  console.log('\n4. Templates');

  const missing = Object.entries(notify.templates).filter(([, fn]) => {
    const out = fn({});
    return !out?.title || !out?.body;
  });
  check(
    'every template renders a title and a body even with no data',
    missing.length === 0,
    missing.map(([k]) => k).join(', ')
  );

  const pw = notify.templates.portalAccess({ name: 'Wanjiru' });
  check(
    'the portal access notice carries no password',
    !/password:\s*\S/i.test(pw.body) || /emailed to you separately/i.test(pw.body)
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Run every enabled trigger against a claim, mirroring what the sweep does but
 * without the database work the service performs around it.
 */
async function runTriggers(referral, ctx, config) {
  const fired = [];
  for (const t of config.referralTriggers) {
    if (t.enabled === false) continue;
    const evaluator = referral.TRIGGERS[t.code];
    if (!evaluator) continue;
    const detail = await evaluator({ ...ctx, params: t.params || {}, config });
    if (detail) fired.push({ code: t.code, detail, autoRefer: Boolean(t.autoRefer) });
  }
  return fired;
}

/**
 * Replace the two notification services with counters.
 *
 * Loaded before legalNotify so it picks up the stubs from require cache.
 */
function stubNotificationServices() {
  const record = { inApp: [], email: [], reset() { this.inApp = []; this.email = []; } };

  record.whatsappSends = () =>
    record.inApp.filter((c) => c.whatsappNumber !== null).length +
    record.email.filter((c) => c.options?.whatsapp !== false).length;

  const notificationPath = require.resolve('../src/service/notification.service');
  require.cache[notificationPath] = {
    id: notificationPath,
    filename: notificationPath,
    loaded: true,
    exports: {
      createAndEmit: async (payload) => { record.inApp.push(payload); return payload; },
    },
  };

  const emailPath = require.resolve('../src/service/email.service');
  require.cache[emailPath] = {
    id: emailPath,
    filename: emailPath,
    loaded: true,
    exports: {
      sendEmailNotification: async (to, subject, body, options) => {
        record.email.push({ to, subject, body, options });
        return true;
      },
    },
  };

  return record;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
