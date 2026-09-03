/**
 * The billing lifecycle sweeps, run against in-memory stand-ins for the models.
 *
 * These transitions are the ones nobody watches: they run at 01:00 and their
 * only witness is the state of the portal the next morning. The property that
 * matters most is idempotence — a worker can die mid-sweep and the job is
 * retried, so a second pass must not double-bill or re-notify.
 */
const path = require('node:path');
const Module = require('node:module');
const root = path.join(__dirname, '..');

// ── Stand-ins ────────────────────────────────────────────────────────────────
const state = { invoices: [], subscriptions: [], emails: [], created: [] };

const matches = (doc, filter) =>
  Object.entries(filter).every(([field, cond]) => {
    // Top-level $or, used by the overdue sweep to skip invoices on an agreed
    // instalment schedule.
    if (field === '$or') return cond.some((sub) => matches(doc, sub));
    const value = doc[field];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$exists' in cond) return (value !== undefined && value !== null) === cond.$exists;
      if ('$in' in cond) return cond.$in.some((v) => String(v) === String(value));
      if ('$ne' in cond) return String(value) !== String(cond.$ne);
      if ('$lt' in cond) return value != null && new Date(value) < new Date(cond.$lt);
      if ('$gte' in cond) return value != null && new Date(value) >= new Date(cond.$gte);
    }
    if (cond === null) return value === null || value === undefined;
    return String(value) === String(cond);
  });

const stubInvoice = {
  find: (filter) => {
    const rows = state.invoices.filter((i) => matches(i, filter));
    return { populate: () => Promise.resolve(rows), then: (r) => r(rows) };
  },
  findOne: (filter) => Promise.resolve(state.invoices.find((i) => matches(i, filter)) ?? null),
  updateMany: (filter, update) => {
    const ids = filter._id.$in.map(String);
    state.invoices.forEach((i) => { if (ids.includes(String(i._id))) Object.assign(i, update.$set); });
    return Promise.resolve({ modifiedCount: ids.length });
  },
};

const stubSubscription = {
  find: (filter) => {
    const rows = state.subscriptions.filter((s) => matches(s, filter));
    return { populate: () => Promise.resolve(rows), then: (r) => r(rows) };
  },
  findById: (id) => ({
    populate: () => Promise.resolve(state.subscriptions.find((s) => String(s._id) === String(id)) ?? null),
  }),
};

const stubInvoiceService = {
  createInvoice: async (data) => {
    const invoice = { _id: `inv${state.invoices.length + 1}`, status: 'draft', issuedDate: new Date(), ...data };
    state.invoices.push(invoice);
    state.created.push(invoice);
    return invoice;
  },
};

const stubEmail = {
  sendEmailNotification: async (to, subject) => { state.emails.push({ to, subject }); },
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith('billingLifecycle.service.js')) {
    if (request.includes('companySubscription.model')) return stubSubscription;
    if (request.includes('invoice.model')) return stubInvoice;
    if (request.includes('invoice.service')) return stubInvoiceService;
    if (request.includes('email.service')) return stubEmail;
    if (request.includes('logger')) return { info() {}, warn() {}, error() {} };
  }
  return origLoad.apply(this, arguments);
};

const billing = require(path.join(root, 'src/service/billingLifecycle.service.js'));

// ── Cases ────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-09-03T01:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const daysAhead = (n) => new Date(NOW.getTime() + n * 86400000);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
};

const reset = () => { state.invoices = []; state.subscriptions = []; state.emails = []; state.created = []; };

(async () => {
  // 1. An unpaid invoice past its due date turns overdue, once, with one chase.
  reset();
  state.invoices.push({
    _id: 'i1', invoiceNumber: 'INV-1', status: 'sent', dueDate: daysAgo(3),
    total: 45000, currency: 'KES', company: { companyName: 'Acme', email: 'ap@acme.co' },
  });
  const first = await billing.markOverdueInvoices({ now: NOW });
  const second = await billing.markOverdueInvoices({ now: NOW });
  check('an overdue invoice is marked once and chased once',
    first.markedOverdue === 1 && second.markedOverdue === 0 && state.emails.length === 1,
    `first=${first.markedOverdue} second=${second.markedOverdue} emails=${state.emails.length}`);

  // 2. Paid, cancelled and not-yet-due invoices are left alone.
  reset();
  state.invoices.push(
    { _id: 'p', status: 'paid', dueDate: daysAgo(30), company: {} },
    { _id: 'c', status: 'cancelled', dueDate: daysAgo(30), company: {} },
    { _id: 'f', status: 'sent', dueDate: daysAhead(5), company: {} },
  );
  const untouched = await billing.markOverdueInvoices({ now: NOW });
  check('paid, cancelled and future invoices are untouched',
    untouched.markedOverdue === 0 && state.invoices.every((i) => i.status !== 'overdue'));

  // 2b. A part-paid invoice past its due date is still chased — money having
  //     arrived does not make the rest not owed.
  reset();
  state.invoices.push({
    _id: 'part', invoiceNumber: 'INV-2', status: 'partially_paid', dueDate: daysAgo(2),
    total: 1000, amountPaid: 400, currency: 'KES', company: { companyName: 'Acme', email: 'ap@acme.co' },
  });
  const partial = await billing.markOverdueInvoices({ now: NOW });
  check('a part-paid invoice past due is chased', partial.markedOverdue === 1);

  // 2c. …unless a next instalment has been agreed for a future date. This is
  //     the whole point of recording that date: a company working through an
  //     accepted schedule is not a company that has stopped paying.
  reset();
  state.invoices.push({
    _id: 'sched', invoiceNumber: 'INV-3', status: 'partially_paid', dueDate: daysAgo(2),
    nextPaymentDate: daysAhead(12), total: 1000, amountPaid: 400, currency: 'KES',
    company: { companyName: 'Acme', email: 'ap@acme.co' },
  });
  const scheduled = await billing.markOverdueInvoices({ now: NOW });
  check('an agreed future instalment holds off the overdue sweep',
    scheduled.markedOverdue === 0 && state.emails.length === 0,
    `marked=${scheduled.markedOverdue} emails=${state.emails.length}`);

  // 2d. Once that agreed date passes, they are chased like anyone else.
  reset();
  state.invoices.push({
    _id: 'missed', invoiceNumber: 'INV-4', status: 'partially_paid', dueDate: daysAgo(30),
    nextPaymentDate: daysAgo(3), total: 1000, amountPaid: 400, currency: 'KES',
    company: { companyName: 'Acme', email: 'ap@acme.co' },
  });
  const missed = await billing.markOverdueInvoices({ now: NOW });
  check('a missed instalment date is chased', missed.markedOverdue === 1);

  // 3. A lapsed subscription that does not auto-renew expires rather than
  //    sitting as 'active' forever — which is what it did before this existed.
  reset();
  state.subscriptions.push({
    _id: 's1', status: 'active', autoRenew: false, endDate: daysAgo(1),
    billingCycle: 'monthly', amount: 1000, currency: 'KES', company: 'c1', plan: { name: 'Pro' },
    save: async function () { return this; },
  });
  const lapse = await billing.rollSubscriptions({ now: NOW });
  check('a lapsed subscription without auto-renew expires',
    lapse.expired === 1 && state.subscriptions[0].status === 'expired',
    `expired=${lapse.expired} status=${state.subscriptions[0].status}`);

  // 4. An auto-renewing subscription gets a new term and one draft invoice.
  reset();
  const start = daysAgo(31);
  state.subscriptions.push({
    _id: 's2', status: 'active', autoRenew: true, startDate: start, endDate: daysAgo(1),
    billingCycle: 'monthly', amount: 45000, currency: 'KES', company: 'c1', plan: { name: 'Enterprise' },
    save: async function () { return this; },
  });
  const roll = await billing.rollSubscriptions({ now: NOW });
  const sub = state.subscriptions[0];
  check('an auto-renewing subscription is extended and invoiced',
    roll.renewed === 1 && roll.invoiced === 1 && sub.status === 'active'
      && new Date(sub.endDate) > NOW && state.created[0]?.status === 'draft',
    `renewed=${roll.renewed} invoiced=${roll.invoiced} end=${sub.endDate}`);

  // 5. The invoice is a DRAFT, not sent — billing a client is signed off by a
  //    person, never emailed unattended by a job.
  check('the renewal invoice is left as a draft', state.created[0]?.status === 'draft');

  // 6. Re-running does not bill the same period twice. This is the one that
  //    matters: BullMQ retries a failed job three times.
  const before = state.created.length;
  await billing.rollSubscriptions({ now: NOW });
  check('a retried sweep does not double-bill',
    state.created.length === before, `created ${state.created.length}, expected ${before}`);

  // 7. Billing by hand refuses a period the sweep already billed.
  const again = await billing.invoiceForPeriod('s2');
  check('billing by hand refuses an already-invoiced period', again === null);

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nAll billing lifecycle cases pass.' : `\n${failed} case(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
