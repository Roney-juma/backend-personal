const CompanySubscription = require('../models/companySubscription.model');
const Invoice = require('../models/invoice.model');
const invoiceService = require('./invoice.service');
const emailService = require('./email.service');
const logger = require('../middlewheres/logger');
const { formatShortDate } = require('../utils/timezone');

/**
 * The clock the billing module never had.
 *
 * Plans, subscriptions and invoices all model a lifecycle, and until now nothing
 * advanced it: a subscription stayed 'active' years past its end date, an
 * invoice stayed 'sent' however long it went unpaid, and `autoRenew` was a
 * checkbox that did nothing. The provider portal has always had an "Overdue"
 * filter — for a status no code path ever set.
 *
 * Everything here is IDEMPOTENT, per the contract in queue/scheduler.js. Each
 * sweep is a state transition guarded by the state it is leaving, so running it
 * twice does nothing the second time, and a worker dying mid-run loses nothing.
 */

/** Money as it appears in mail: "KES 45,000". */
const money = (currency, amount) =>
  `${currency || ''} ${Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();

/**
 * Invoices whose due date has passed while still unpaid.
 *
 * Guarded on `status: 'sent'`, so a second run finds nothing: an invoice already
 * moved to 'overdue' no longer matches. Paid and cancelled invoices are never
 * touched, however old.
 */
const markOverdueInvoices = async ({ now = new Date() } = {}) => {
  const due = await Invoice.find({
    // Part-paid counts: money having arrived does not make the rest not owed.
    status: { $in: ['sent', 'partially_paid'] },
    dueDate: { $lt: now },
    /**
     * An agreed next instalment date, still in the future, means the company is
     * working through a schedule we accepted — chasing them for being "overdue"
     * against the original due date would be wrong, and would train them to
     * ignore the notice that matters. Once that date passes they are chased
     * like anyone else.
     */
    $or: [{ nextPaymentDate: { $exists: false } }, { nextPaymentDate: null }, { nextPaymentDate: { $lt: now } }],
  }).populate('company', 'companyName email');

  if (due.length === 0) return { markedOverdue: 0 };

  await Invoice.updateMany(
    { _id: { $in: due.map((i) => i._id) } },
    { $set: { status: 'overdue' } },
  );

  // One chase per invoice, on the day it turns. Sending on every subsequent
  // sweep would mean a daily email until someone pays, which is how a billing
  // notice becomes something people filter out.
  for (const invoice of due) {
    if (!invoice.company?.email) continue;
    emailService
      .sendEmailNotification(
        invoice.company.email,
        `Overdue: invoice ${invoice.invoiceNumber}`,
        `Dear ${invoice.company.companyName},\n\n` +
          `Invoice ${invoice.invoiceNumber} was due on ${formatShortDate(invoice.dueDate)} and is now overdue.\n\n` +
          // What is still owed, not the face value — chasing a company for the
          // full amount when they have already paid two thirds of it is the
          // kind of notice that gets a relationship manager an angry call.
          (invoice.amountPaid > 0
            ? `Invoice total: ${money(invoice.currency, invoice.total)}\n` +
              `Already paid:  ${money(invoice.currency, invoice.amountPaid)}\n` +
              `Still due:     ${money(invoice.currency, invoice.total - invoice.amountPaid)}\n\n`
            : `Amount due: ${money(invoice.currency, invoice.total)}\n\n`) +
          `If you have already paid, please ignore this message and accept our thanks.\n\n` +
          `AVE Provider Platform`,
      )
      .catch((err) => logger.warn(`[billing] overdue notice failed for ${invoice.invoiceNumber}: ${err.message}`));
  }

  logger.info(`[billing] marked ${due.length} invoice(s) overdue`);
  return { markedOverdue: due.length };
};

/**
 * Raise the invoice for a subscription's current period.
 *
 * Shared by the renewal sweep and the portal's "Bill this period" action, so a
 * subscription billed by hand and one billed by the clock produce the same
 * document. Returns null when the period has already been invoiced — which is
 * what makes the renewal sweep safe to retry.
 */
const invoiceForPeriod = async (subscription, { periodStart, periodEnd, dueInDays = 14 } = {}) => {
  const sub = subscription.plan?.name
    ? subscription
    : await CompanySubscription.findById(subscription._id ?? subscription).populate('plan');
  if (!sub) return null;

  const start = periodStart ?? sub.startDate;
  const end = periodEnd ?? sub.endDate;

  // One invoice per subscription per period. The window match is on issuedDate
  // rather than a stored period, because an invoice raised for this term is the
  // only thing that could have been raised between these two dates.
  const existing = await Invoice.findOne({
    subscription: sub._id,
    status: { $ne: 'cancelled' },
    issuedDate: { $gte: new Date(start) },
  });
  if (existing) return null;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + dueInDays);

  const planName = sub.plan?.name ?? 'Subscription';
  return invoiceService.createInvoice({
    company: sub.company?._id ?? sub.company,
    subscription: sub._id,
    items: [
      {
        description: `${planName} — ${sub.billingCycle} subscription, ${formatShortDate(start)} to ${formatShortDate(end)}`,
        quantity: 1,
        unitPrice: sub.amount,
      },
    ],
    currency: sub.currency,
    dueDate,
    notes: `Raised automatically for subscription period ending ${formatShortDate(end)}.`,
  });
};

/**
 * Roll subscriptions past their end date forward, or let them lapse.
 *
 * `autoRenew` finally means something: a renewing subscription gets a new term
 * and a draft invoice for it, and one that is not renewing becomes 'expired'
 * rather than sitting as 'active' indefinitely.
 *
 * The invoice is left as a DRAFT on purpose. Billing a client is a decision
 * somebody signs off, and a job that emailed invoices unattended is a job that
 * eventually emails a wrong one.
 */
const rollSubscriptions = async ({ now = new Date() } = {}) => {
  const lapsed = await CompanySubscription.find({
    status: { $in: ['active', 'trial'] },
    endDate: { $lt: now },
  }).populate('plan');

  let renewed = 0;
  let expired = 0;
  let invoiced = 0;

  for (const sub of lapsed) {
    try {
      if (!sub.autoRenew) {
        // Guarded by the status filter above: a second run will not match this.
        sub.status = 'expired';
        await sub.save();
        expired += 1;
        continue;
      }

      const previousEnd = new Date(sub.endDate);
      const newEnd = new Date(previousEnd);
      if (sub.billingCycle === 'annually') newEnd.setFullYear(newEnd.getFullYear() + 1);
      else newEnd.setMonth(newEnd.getMonth() + 1);

      sub.endDate = newEnd;
      sub.nextBillingDate = new Date(newEnd);
      sub.status = 'active';
      await sub.save();
      renewed += 1;

      const invoice = await invoiceForPeriod(sub, { periodStart: previousEnd, periodEnd: newEnd });
      if (invoice) invoiced += 1;
    } catch (err) {
      // One bad subscription must not stop the sweep for the rest.
      logger.error(`[billing] could not roll subscription ${sub._id}: ${err.message}`);
    }
  }

  if (lapsed.length > 0) {
    logger.info(`[billing] rolled ${lapsed.length} subscription(s) | renewed=${renewed} expired=${expired} invoiced=${invoiced}`);
  }
  return { renewed, expired, invoiced };
};

/**
 * Everything the clock owes the billing module, in one pass.
 * Order matters only in that rolling a subscription can raise an invoice, and a
 * freshly raised draft should not be judged overdue in the same run.
 */
const runBillingLifecycle = async ({ now = new Date() } = {}) => {
  const overdue = await markOverdueInvoices({ now });
  const rolled = await rollSubscriptions({ now });
  return { ...overdue, ...rolled };
};

module.exports = {
  markOverdueInvoices,
  rollSubscriptions,
  invoiceForPeriod,
  runBillingLifecycle,
};
