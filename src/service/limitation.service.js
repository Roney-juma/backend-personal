const LegalEvent = require('../models/legalEvent.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const legalConfig = require('./legalConfig.service');
const logger = require('../middlewheres/logger');
const ApiError = require('../utils/ApiError');
const { EVENT_KINDS } = require('../constants/legal.constants');

/**
 * Statutory limitation clocks.
 *
 * A time-barred claim is the cheapest possible way to lose a defence and the
 * easiest thing to automate, so no third-party claim is registered without one.
 * The date is derived from the tenant's configured period for the claim type and
 * mirrored into a LegalEvent, which means it rides exactly the same reminder and
 * escalation machinery as a court date rather than being a special case someone
 * has to remember to check.
 *
 * Periods are per-tenant configuration, never hard-coded here — jurisdictions
 * and claim types differ, and getting one wrong silently loses defences.
 */

/**
 * Add whole months to a date, clamping to the end of the target month.
 *
 * Naive month arithmetic overflows: 31 August + 6 months lands on 31 February,
 * which JavaScript silently rolls forward into March. For a limitation date that
 * would hand back days that do not exist, so the last day of the shorter month
 * is used instead — the conservative direction.
 */
function addMonths(date, months) {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  const result = new Date(d.getTime());
  result.setDate(1);
  result.setMonth(targetMonth);

  const lastDayOfTarget = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(d.getDate(), lastDayOfTarget));
  // Limitation runs to the end of the day.
  result.setHours(23, 59, 59, 999);
  return result;
}

/**
 * Work out when a third-party claim becomes time-barred.
 *
 * @param {Object} params
 * @param {*}      params.company
 * @param {string} params.claimType
 * @param {Date}   params.accrualDate  usually the accident date; date of death for a fatal claim
 * @returns {Promise<Object>} limitation block
 */
async function computeLimitation({ company, claimType, accrualDate }) {
  if (!accrualDate) {
    throw new ApiError(400, 'A limitation date needs an accrual date (normally the accident date)');
  }

  const periodMonths = await legalConfig.limitationMonths(company, claimType);
  const accrual = new Date(accrualDate);

  return {
    accrualDate: accrual,
    periodMonths,
    expiresAt: addMonths(accrual, periodMonths),
    basis: `${periodMonths} months from ${accrual.toISOString().slice(0, 10)} (${claimType})`,
  };
}

/**
 * Create or refresh the diary event that carries a limitation date's reminders.
 *
 * Idempotent: re-registering an unchanged date is a no-op, and a changed date
 * cancels the old event and creates a new one rather than mutating it — the
 * history of "we thought it expired then, now we think it expires now" is worth
 * keeping on a deadline of this consequence.
 *
 * @param {Object} tpc  a ThirdPartyClaim document
 * @param {Object} [actor]
 * @returns {Promise<Object|null>} the LegalEvent
 */
async function syncLimitationEvent(tpc, actor = null) {
  const expiresAt = tpc.limitation?.extendedTo || tpc.limitation?.expiresAt;
  if (!expiresAt) return null;

  const existing = tpc.limitation.eventId
    ? await LegalEvent.findById(tpc.limitation.eventId)
    : null;

  if (existing && existing.dueAt.getTime() === new Date(expiresAt).getTime() && existing.status !== 'cancelled') {
    return existing;
  }

  const config = await legalConfig.get(tpc.company);
  // A time-bar warrants a much longer runway than an ordinary deadline: at 30
  // days' notice there may be no time left to file.
  const reminderOffsets = config.limitationWarningDays || [180, 90, 60, 30, 14, 7];

  if (existing) {
    existing.status = 'cancelled';
    existing.outcome = `Superseded — limitation date revised to ${new Date(expiresAt).toISOString().slice(0, 10)}`;
    await existing.save();
  }

  const event = await LegalEvent.create({
    company: tpc.company,
    thirdPartyClaim: tpc._id,
    claim: tpc.claim,
    kind: EVENT_KINDS.LIMITATION,
    eventType: 'limitation',
    title: `Time-bar — ${tpc.party?.name || 'third-party claim'} (${tpc.referenceNumber || 'unreferenced'})`,
    description:
      `Statutory limitation expires. ${tpc.limitation.basis || ''}`.trim() +
      '\nAfter this date the claim can no longer be brought, and any suit filed is liable to be struck out.',
    dueAt: new Date(expiresAt),
    responsibleType: tpc.handler ? 'Users' : 'Role',
    responsible: tpc.handler || undefined,
    responsibleRole: tpc.handler ? undefined : 'Legal Officer',
    reminderOffsets,
    source: 'system',
    createdBy: actor?._id || actor?.id || null,
    adjournedFrom: existing?._id,
  });

  tpc.limitation.eventId = event._id;
  return event;
}

/**
 * Register a limitation clock on a third-party claim, in one call.
 * Mutates the document but does not save it — the caller owns the transaction.
 */
async function attachLimitation(tpc, { accrualDate } = {}) {
  const accrual =
    accrualDate ||
    tpc.limitation?.accrualDate ||
    // A fatal claim's clock normally runs from the death, not the accident.
    (tpc.injury?.deceased && tpc.injury?.dateOfDeath) ||
    tpc.accidentDate;

  if (!accrual) {
    throw new ApiError(
      400,
      'Cannot register a third-party claim without an accident date to run the limitation clock from'
    );
  }

  const limitation = await computeLimitation({
    company: tpc.company,
    claimType: tpc.claimType,
    accrualDate: accrual,
  });

  tpc.limitation = { ...(tpc.limitation || {}), ...limitation };
  return tpc.limitation;
}

/**
 * Extend or restart a limitation clock — acknowledgement of liability or a part
 * payment can do this. Always an explicit, reasoned act: a wrongly extended
 * clock is worse than none, because it reads as safe.
 */
async function extendLimitation(tpcId, { extendedTo, reason }, actor = null) {
  if (!extendedTo) throw new ApiError(400, 'A new limitation date is required');
  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, 'Extending a limitation period requires a reason');
  }

  const tpc = await ThirdPartyClaim.findById(tpcId);
  if (!tpc) throw new ApiError(404, 'Third-party claim not found');

  const newDate = new Date(extendedTo);
  if (Number.isNaN(newDate.getTime())) throw new ApiError(400, 'Invalid limitation date');

  const current = tpc.limitation?.extendedTo || tpc.limitation?.expiresAt;
  if (current && newDate < new Date(current)) {
    // Shortening is legitimate but unusual — log it loudly rather than block it.
    logger.warn(
      `[limitation] ${tpc.referenceNumber} limitation SHORTENED from ` +
      `${new Date(current).toISOString().slice(0, 10)} to ${newDate.toISOString().slice(0, 10)} — ${reason}`
    );
  }

  tpc.limitation.extendedTo = newDate;
  tpc.limitation.extensionReason = reason;
  await syncLimitationEvent(tpc, actor);
  await tpc.save();

  return tpc;
}

/**
 * Days remaining before a claim is time-barred. Negative once expired.
 */
function daysRemaining(tpc, now = new Date()) {
  const expiry = tpc?.limitation?.extendedTo || tpc?.limitation?.expiresAt;
  if (!expiry) return null;
  return Math.ceil((new Date(expiry).getTime() - now.getTime()) / 86400000);
}

/**
 * The time-bar register: open claims ordered by how soon they expire.
 *
 * This is the query the Legal team should look at first every morning, and the
 * one the scheduled sweep runs.
 *
 * @param {Object} params
 * @param {*}      params.company
 * @param {number} [params.withinDays]  only those expiring within this window
 * @param {boolean}[params.includeExpired=true]
 */
async function register({ company, withinDays = null, includeExpired = true, limit = 200 }) {
  const now = new Date();
  const filter = {
    company,
    // A settled, paid or closed claim has no live clock.
    status: { $nin: ['settled', 'paid', 'closed', 'time_barred'] },
    'limitation.expiresAt': { $exists: true, $ne: null },
  };

  const upper = withinDays
    ? new Date(now.getTime() + withinDays * 86400000)
    : null;

  if (upper && includeExpired) {
    filter['limitation.expiresAt'] = { $lte: upper };
  } else if (upper) {
    filter['limitation.expiresAt'] = { $gte: now, $lte: upper };
  } else if (!includeExpired) {
    filter['limitation.expiresAt'] = { $gte: now };
  }

  const claims = await ThirdPartyClaim.find(filter)
    .sort({ 'limitation.expiresAt': 1 })
    .limit(limit)
    .populate('claim', 'incidentDetails.date vehiclesInvolved.licensePlate')
    .lean();

  return claims.map((c) => ({
    ...c,
    daysRemaining: daysRemaining(c, now),
    expired: daysRemaining(c, now) < 0,
  }));
}

module.exports = {
  computeLimitation,
  attachLimitation,
  syncLimitationEvent,
  extendLimitation,
  daysRemaining,
  register,
  addMonths,
};
