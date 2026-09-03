/**
 * markAsPaid, against an in-memory Invoice model.
 *
 * The rules worth pinning down are the ones that were wrong or missing: paying
 * a draft must work (the portal used to gate it behind Send), a supplied date
 * must be honoured (revenue lands in the month the money arrived, not the month
 * somebody got round to recording it), and paying twice must not overwrite the
 * first payment's details.
 */
const path = require('node:path');
const Module = require('node:module');

const store = new Map();
const activated = [];
const stubInvoice = {
  findById: (id) => Promise.resolve(store.get(id) ?? null),
  findByIdAndUpdate: (id, update) => {
    const doc = { ...store.get(id), ...update };
    store.set(id, doc);
    return Promise.resolve(doc);
  },
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith('invoice.service.js')) {
    if (request.includes('invoice.model')) return stubInvoice;
    if (request.includes('email.service')) return { sendInvoiceEmail: async () => {} };
    if (request.includes('generateInvoicePdf')) return async () => Buffer.from('');
    if (request.includes('logger')) return { info() {}, warn() {}, error() {} };
    if (request.includes('companySubscription.service')) return { activateFromPayment: async (a) => { activated.push(a); return { _id: 'sub1' }; } };
  }
  return origLoad.apply(this, arguments);
};

const service = require(path.join(__dirname, '..', 'src/service/invoice.service.js'));

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
};

const seed = (id, status, extra = {}) => {
  const doc = {
    _id: id, invoiceNumber: 'INV-' + id, status, total: 1000, currency: 'KES',
    amountPaid: 0, payments: [], ...extra,
    save: async function () { store.set(id, this); return this; },
  };
  store.set(id, doc);
  return doc;
};

(async () => {
  // A draft can be paid. This is the whole point: the portal made Send a gate,
  // so recording money forced an email the client may not want.
  seed('a', 'draft');
  const draftPaid = await service.markAsPaid('a', { paymentMethod: 'M-Pesa', paymentReference: 'QGR7X' });
  check('a draft can be marked paid without being sent',
    draftPaid.status === 'paid' && draftPaid.paymentMethod === 'M-Pesa' && draftPaid.paymentReference === 'QGR7X',
    JSON.stringify(draftPaid));

  seed('b', 'overdue');
  const overduePaid = await service.markAsPaid('b', {});
  check('an overdue invoice can be paid', overduePaid.status === 'paid');

  // The supplied date wins, so late-recorded payments land in the right month.
  seed('c', 'sent');
  const backdated = await service.markAsPaid('c', { paidDate: '2026-08-14' });
  check('a supplied payment date is honoured',
    new Date(backdated.paidDate).toISOString().startsWith('2026-08-14'),
    String(backdated.paidDate));

  seed('d', 'sent');
  const defaulted = await service.markAsPaid('d', {});
  check('no date supplied falls back to now', defaulted.paidDate instanceof Date);

  // Cancelled is terminal — reviving it by payment would leave a bill nobody
  // agreed to owe in the revenue figures.
  seed('e', 'cancelled');
  let refused = false;
  try { await service.markAsPaid('e', {}); } catch { refused = true; }
  check('a cancelled invoice is refused', refused && store.get('e').status === 'cancelled');

  // Idempotent: a double-click is not a second payment.
  seed('f', 'sent');
  const once = await service.markAsPaid('f', { paymentReference: 'FIRST' });
  const twice = await service.markAsPaid('f', { paymentReference: 'SECOND' });
  check('paying twice keeps the first payment details',
    twice.paymentReference === 'FIRST' && twice.paidDate === once.paidDate,
    JSON.stringify(twice));

  // ── Instalments ────────────────────────────────────────────────────────────

  const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

  // A batch payment leaves the invoice part-paid, with the balance tracked and
  // the agreed next date recorded.
  seed('g', 'sent');
  const first = await service.markAsPaid('g', {
    amount: 400, paymentMethod: 'M-Pesa', paymentReference: 'A1', nextPaymentDate: '2026-10-01',
  });
  check('a part payment leaves the invoice partially paid',
    first.status === 'partially_paid' && first.amountPaid === 400 && first.payments.length === 1
      && first.paidDate === undefined && iso(first.nextPaymentDate) === '2026-10-01',
    JSON.stringify({ status: first.status, amountPaid: first.amountPaid, paidDate: first.paidDate }));

  // Each instalment is its own row, so three transfers reconcile individually.
  const second = await service.markAsPaid('g', { amount: 350, paymentReference: 'A2' });
  check('a second instalment adds to the balance and keeps both rows',
    second.amountPaid === 750 && second.payments.length === 2 && second.status === 'partially_paid',
    JSON.stringify({ amountPaid: second.amountPaid, rows: second.payments.length }));

  // The closing instalment settles it, stamps the date and clears the schedule.
  const final = await service.markAsPaid('g', { amount: 250, paidDate: '2026-10-01' });
  check('the closing instalment settles the invoice and clears the next date',
    final.status === 'paid' && final.amountPaid === 1000 && final.nextPaymentDate === undefined
      && iso(final.paidDate) === '2026-10-01',
    JSON.stringify({ status: final.status, next: final.nextPaymentDate }));

  // Overpaying is refused rather than silently accepted: an invoice showing a
  // negative balance is worse than a rejected entry.
  seed('h', 'sent');
  await service.markAsPaid('h', { amount: 900 });
  let tooMuch = false;
  try { await service.markAsPaid('h', { amount: 200 }); } catch { tooMuch = true; }
  check('paying more than the balance is refused', tooMuch && store.get('h').amountPaid === 900);

  seed('i', 'sent');
  let nonPositive = false;
  try { await service.markAsPaid('i', { amount: 0 }); } catch { nonPositive = true; }
  check('a zero payment is refused', nonPositive);

  // Rounding: three uneven thirds must still settle exactly, or the invoice
  // sits at a fraction outstanding for ever.
  seed('j', 'sent', { total: 100 });
  await service.markAsPaid('j', { amount: 33.33 });
  await service.markAsPaid('j', { amount: 33.33 });
  const thirds = await service.markAsPaid('j', { amount: 33.34 });
  check('uneven instalments settle exactly, with no floating-point remainder',
    thirds.status === 'paid' && thirds.amountPaid === 100, String(thirds.amountPaid));

  // Omitting the amount settles whatever is left — the common case.
  seed('k', 'sent');
  await service.markAsPaid('k', { amount: 600 });
  const rest = await service.markAsPaid('k', {});
  check('omitting the amount settles the remaining balance',
    rest.status === 'paid' && rest.amountPaid === 1000, String(rest.amountPaid));

  // Access follows the money in full: a third of an annual plan does not buy a
  // year of the platform, and there is no way to take it back.
  activated.length = 0;
  seed('m', 'sent', { company: 'c1', purchase: { plan: 'pro', billingCycle: 'monthly' } });
  await service.markAsPaid('m', { amount: 500 });
  const afterPart = activated.length;
  await service.markAsPaid('m', { amount: 500 });
  check('a plan activates on full settlement, not on the first instalment',
    afterPart === 0 && activated.length === 1,
    `afterPart=${afterPart} afterFull=${activated.length}`);

  const missing = await service.markAsPaid('nope', {});
  check('an unknown invoice returns null', missing === null);

  const failed = results.filter((r) => !r).length;
  console.log(failed === 0 ? '\nAll invoice payment cases pass.' : `\n${failed} case(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
