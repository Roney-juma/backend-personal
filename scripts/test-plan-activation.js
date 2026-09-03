/**
 * activateFromPayment — the join between money arriving and access starting.
 *
 * This is the one place in billing where getting it wrong hands out something
 * for free or takes away something paid for, so the cases below are the ones
 * that decide term length: paying early, paying after a lapse, and changing
 * plan mid-term.
 */
const path = require('node:path');
const Module = require('node:module');

const plans = new Map([
  ['pro', { _id: 'pro', name: 'Pro', currency: 'KES', price: { monthly: 45000, annually: 480000 } }],
  ['ent', { _id: 'ent', name: 'Enterprise', currency: 'KES', price: { monthly: 90000, annually: 950000 } }],
]);
let subs = [];

const stubPlan = { findById: (id) => Promise.resolve(plans.get(String(id)) ?? null) };

const stubSub = function (doc) { Object.assign(this, doc); };
stubSub.prototype.save = async function () {
  if (!subs.includes(this)) subs.push(this);
  return this;
};
stubSub.findOne = (filter) => {
  const wanted = filter.status.$in;
  const found = subs
    .filter((s) => String(s.company) === String(filter.company) && wanted.includes(s.status))
    .sort((a, b) => new Date(b.endDate) - new Date(a.endDate));
  return { sort: () => Promise.resolve(found[0] ?? null) };
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith('companySubscription.service.js')) {
    if (request.includes('companySubscription.model')) return stubSub;
    if (request.includes('subscriptionPlan.model')) return stubPlan;
  }
  return origLoad.apply(this, arguments);
};

const service = require(path.join(__dirname, '..', 'src/service/companySubscription.service.js'));

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
};

const day = 86400000;
const NOW = new Date('2026-09-03T00:00:00Z');
const iso = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  // A company with nothing gets a fresh subscription priced from the plan.
  subs = [];
  const fresh = await service.activateFromPayment({ company: 'c1', plan: 'pro', billingCycle: 'monthly', startAt: NOW });
  check('a first payment starts a subscription at the plan price',
    fresh.status === 'active' && fresh.amount === 45000 && fresh.currency === 'KES' && iso(fresh.endDate) === '2026-10-03',
    JSON.stringify({ amount: fresh.amount, end: iso(fresh.endDate) }));

  // Paying while a term is still running ADDS to it. Renewing early must not
  // cost the company the days they have already paid for.
  subs = [];
  await service.activateFromPayment({ company: 'c1', plan: 'pro', startAt: NOW });
  const early = await service.activateFromPayment({ company: 'c1', plan: 'pro', startAt: new Date(NOW.getTime() + 10 * day) });
  check('renewing early extends from the existing end, not from today',
    iso(early.endDate) === '2026-11-03' && subs.length === 1,
    `end=${iso(early.endDate)} subs=${subs.length}`);

  // Paying after a lapse starts from today — no back-dating into days that
  // were never usable.
  subs = [];
  const lapsed = new stubSub({
    company: 'c2', plan: 'pro', status: 'active', billingCycle: 'monthly',
    endDate: new Date(NOW.getTime() - 40 * day), amount: 45000, currency: 'KES',
  });
  await lapsed.save();
  lapsed.status = 'expired';
  const revived = await service.activateFromPayment({ company: 'c2', plan: 'pro', startAt: NOW });
  check('paying after a lapse starts a term from the payment date',
    iso(revived.endDate) === '2026-10-03', `end=${iso(revived.endDate)}`);

  // Upgrading moves the live subscription rather than creating a second one:
  // two live subscriptions would make "what is this company on?" ambiguous.
  subs = [];
  await service.activateFromPayment({ company: 'c3', plan: 'pro', startAt: NOW });
  const upgraded = await service.activateFromPayment({ company: 'c3', plan: 'ent', billingCycle: 'annually', startAt: NOW });
  check('an upgrade moves the existing subscription, not a second one',
    subs.length === 1 && String(upgraded.plan) === 'ent' && upgraded.amount === 950000 && upgraded.billingCycle === 'annually',
    `subs=${subs.length} plan=${upgraded.plan} amount=${upgraded.amount}`);

  // A paid trial is no longer a trial.
  subs = [];
  const trial = new stubSub({
    company: 'c4', plan: 'pro', status: 'trial', billingCycle: 'monthly',
    endDate: new Date(NOW.getTime() + 5 * day), trialEndDate: new Date(NOW.getTime() + 5 * day),
    amount: 0, currency: 'KES',
  });
  await trial.save();
  const converted = await service.activateFromPayment({ company: 'c4', plan: 'pro', startAt: NOW });
  check('paying converts a trial into an active subscription',
    converted.status === 'active' && converted.trialEndDate === undefined && converted.amount === 45000,
    JSON.stringify({ status: converted.status, trialEndDate: converted.trialEndDate }));

  // A plan that has since been deleted cannot activate anything.
  const gone = await service.activateFromPayment({ company: 'c5', plan: 'nope', startAt: NOW });
  check('an unknown plan returns null rather than half-activating', gone === null);

  const failed = results.filter((r) => !r).length;
  console.log(failed === 0 ? '\nAll plan activation cases pass.' : `\n${failed} case(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
