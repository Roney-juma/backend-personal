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

const seed = (id, status) => store.set(id, { _id: id, status, total: 1000, currency: 'KES' });

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

  const missing = await service.markAsPaid('nope', {});
  check('an unknown invoice returns null', missing === null);

  const failed = results.filter((r) => !r).length;
  console.log(failed === 0 ? '\nAll invoice payment cases pass.' : `\n${failed} case(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
