const LegalEvent = require('../models/legalEvent.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const User = require('../models/users.model');
const Role = require('../models/roles.model');
const legalConfig = require('./legalConfig.service');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const { EVENT_KINDS } = require('../constants/legal.constants');

/**
 * Deadline reminders and escalation.
 *
 * Driven by the repeatable jobs in queue/scheduler.js. Everything here must be
 * IDEMPOTENT — a worker can die mid-sweep and the job is retried, so "have I
 * already sent this?" has to be answerable from the data.
 *
 * The mechanism: each event records every reminder it has sent in
 * `remindersSent[{ offsetDays, sentAt }]`. A sweep only sends an offset that is
 * both due and absent from that list. Two workers racing produce at worst one
 * duplicate; a crashed worker produces none.
 */

const DAY_MS = 86400000;

/**
 * Lazily loaded: notification.service pulls in socket.js, which reads the JWT
 * keypair at import time. Requiring it at module load would make the pure
 * scheduling logic below untestable anywhere the keys are not provisioned, and
 * would couple a sweep that mostly reads the database to the web tier's crypto.
 */
const notifications = () => require('./notification.service');

/** Whole days from now until `date`. Negative once past. */
const daysUntil = (date, now = new Date()) =>
  Math.ceil((new Date(date).getTime() - now.getTime()) / DAY_MS);

/**
 * Which reminder offsets are now due on an event and have not yet been sent.
 *
 * An offset fires once the deadline is that close OR closer — so a claim
 * registered eight days before its deadline still gets the 30- and 14-day
 * warnings immediately rather than silently skipping them. Getting this wrong
 * on a limitation date means the one warning that mattered never arrives.
 */
function dueOffsets(event, now = new Date()) {
  const remaining = daysUntil(event.dueAt, now);
  if (remaining < 0) return [];

  const sent = new Set((event.remindersSent || []).map((r) => r.offsetDays));
  return (event.reminderOffsets || [])
    .filter((offset) => remaining <= offset && !sent.has(offset))
    .sort((a, b) => b - a);
}

/**
 * Resolve who to notify for an event.
 *
 * Events are assigned to a named person, to our panel advocate, or to a role
 * (nobody in particular yet) — the last is common for system-generated
 * limitation clocks on unassigned claims, and resolving it to everyone holding
 * the role is the difference between a warning being seen and being missed.
 */
async function resolveRecipients(event) {
  if (event.responsibleType === 'Users' && event.responsible) {
    const user = await User.findById(event.responsible).select('fullName email').lean();
    return user ? [{ id: user._id, name: user.fullName, email: user.email }] : [];
  }

  // Advocate reminders are Phase 3 — the portal does not exist yet, so notifying
  // them now would send mail nobody can act on.
  if (event.responsibleType === 'Advocate') return [];

  const roleName = event.responsibleRole || 'Legal Officer';
  const roles = await Role.find({ company: event.company, name: roleName }).select('_id').lean();
  if (!roles.length) return [];

  const users = await User.find({
    company: event.company,
    role: { $in: roles.map((r) => r._id) },
    active: true,
  })
    .select('fullName email')
    .limit(20)
    .lean();

  return users.map((u) => ({ id: u._id, name: u.fullName, email: u.email }));
}

/** Human phrasing for how far out a deadline is. */
function urgencyPhrase(days) {
  if (days === 0) return 'TODAY';
  if (days === 1) return 'TOMORROW';
  if (days < 0) return `${Math.abs(days)} days OVERDUE`;
  return `in ${days} days`;
}

/**
 * Send one reminder for one event and record that it went.
 *
 * The record is written even on partial delivery failure: a reminder that
 * half-sent and then retries forever is worse than one that logged its attempt.
 */
async function sendReminder(event, offsetDays, { overdue = false } = {}) {
  const recipients = await resolveRecipients(event);
  if (!recipients.length) {
    logger.warn(
      `[legal-reminder] no recipient for event ${event._id} (${event.eventType}) — ` +
      `responsible ${event.responsibleType}/${event.responsibleRole || event.responsible}`
    );
    // Still record it: with nobody to tell, re-attempting every hour is noise.
    event.remindersSent.push({ offsetDays, sentAt: new Date(), channels: [], recipients: [] });
    return { sent: 0 };
  }

  const remaining = daysUntil(event.dueAt);
  const isLimitation = event.kind === EVENT_KINDS.LIMITATION;

  const title = isLimitation
    ? `Time-bar ${urgencyPhrase(remaining)} — ${event.title}`
    : `${event.title} — ${urgencyPhrase(remaining)}`;

  const content = [
    event.description || '',
    `Due: ${new Date(event.dueAt).toDateString()}`,
    event.court ? `Court: ${event.court}${event.courtStation ? `, ${event.courtStation}` : ''}` : '',
    isLimitation && remaining <= 30
      ? 'Once this date passes the claim can no longer be brought. If a suit is to be filed, it must be filed now.'
      : '',
    overdue ? 'This deadline has passed and no action has been recorded.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  let sent = 0;
  for (const recipient of recipients) {
    try {
      await notifications().createAndEmit({
        recipientId: recipient.id,
        recipientType: 'admin', // insurer-portal staff
        type: isLimitation ? 'legal_time_bar' : 'legal_deadline',
        title,
        content,
        claimId: event.claim,
      });
      sent += 1;
    } catch (err) {
      logger.error(`[legal-reminder] failed to notify ${recipient.id}: ${err.message}`);
    }
  }

  event.remindersSent.push({
    offsetDays,
    sentAt: new Date(),
    channels: ['in_app', 'email', 'whatsapp'],
    recipients: recipients.map((r) => r.id),
  });

  return { sent };
}

// ── Sweeps ───────────────────────────────────────────────────────────────────

/**
 * Send every reminder now due across all open diary events.
 */
async function runDiaryReminders({ now = new Date() } = {}) {
  // Only events with a live ladder and a future due date can have a reminder due.
  const events = await LegalEvent.find({
    status: { $in: ['scheduled', 'pending'] },
    dueAt: { $gte: now },
    reminderOffsets: { $exists: true, $ne: [] },
  })
    .sort({ dueAt: 1 })
    .limit(2000);

  let remindersSent = 0;
  let eventsTouched = 0;

  for (const event of events) {
    const offsets = dueOffsets(event, now);
    if (!offsets.length) continue;

    // Only the tightest due offset fires: if a claim was registered late and
    // three offsets are due at once, the recipient needs one "in 7 days" alert,
    // not three of increasing irrelevance. The rest are marked sent.
    const [tightest, ...superseded] = offsets.sort((a, b) => a - b);
    const { sent } = await sendReminder(event, tightest);
    remindersSent += sent;

    for (const offset of superseded) {
      event.remindersSent.push({
        offsetDays: offset,
        sentAt: new Date(),
        channels: [],
        recipients: [],
      });
    }

    await event.save();
    eventsTouched += 1;
  }

  return { eventsTouched, remindersSent, scanned: events.length };
}

/**
 * Warn on approaching time-bars and mark those that have passed.
 *
 * The most consequential job in the module: after the date passes, the claim can
 * no longer be brought, and if we failed to file, the defence is lost by default.
 */
async function runLimitationSweep({ now = new Date() } = {}) {
  const expired = await ThirdPartyClaim.find({
    status: { $nin: ['settled', 'paid', 'closed', 'time_barred', 'suit_filed', 'litigated', 'judgment'] },
    'limitation.expiresAt': { $lt: now },
  }).limit(500);

  let markedExpired = 0;
  for (const tpc of expired) {
    // An extension supersedes the original date.
    const effective = tpc.limitation?.extendedTo || tpc.limitation?.expiresAt;
    if (new Date(effective) >= now) continue;

    tpc.status = 'time_barred';
    tpc.outcome = 'time_barred';
    await tpc.save();
    markedExpired += 1;

    logger.warn(
      `[limitation-sweep] ${tpc.referenceNumber} is now TIME-BARRED ` +
      `(expired ${new Date(effective).toISOString().slice(0, 10)}, ` +
      `reserve ${money.formatMinor(tpc.reserve?.currentMinor || 0)})`
    );

    // Close the diary event so it stops reminding, but leave the history.
    if (tpc.limitation?.eventId) {
      await LegalEvent.updateOne(
        { _id: tpc.limitation.eventId, status: { $in: ['scheduled', 'pending'] } },
        { $set: { status: 'missed', outcome: 'Limitation period expired' } }
      );
    }
  }

  // Approaching time-bars ride the ordinary reminder ladder via their events, so
  // this sweep only needs to handle expiry. Report the near ones for the log.
  const approaching = await ThirdPartyClaim.countDocuments({
    status: { $nin: ['settled', 'paid', 'closed', 'time_barred'] },
    'limitation.expiresAt': { $gte: now, $lte: new Date(now.getTime() + 90 * DAY_MS) },
  });

  return { markedExpired, approachingWithin90Days: approaching };
}

/**
 * Mark passed deadlines as missed and walk them up the tenant's escalation chain.
 *
 * Escalation is per-tenant configuration (Legal Officer → Senior Legal Officer →
 * Head of Claims → GM → CEO by default). Each rung is notified once; the chain
 * advances only after the configured quiet period with no acknowledgement.
 */
async function runOverdueEscalation({ now = new Date() } = {}) {
  const overdue = await LegalEvent.find({
    status: { $in: ['scheduled', 'pending'] },
    dueAt: { $lt: now },
  })
    .sort({ dueAt: 1 })
    .limit(1000);

  let marked = 0;
  let escalated = 0;

  for (const event of overdue) {
    if (event.status !== 'missed') {
      event.status = 'missed';
      marked += 1;
    }

    const chain = await legalConfig.escalationChain(event.company);
    if (!chain.length) {
      await event.save();
      continue;
    }

    const currentRung = event.escalationRung || 0;
    const next = chain.find((r) => r.rung === currentRung + 1);
    if (!next) {
      await event.save();
      continue;
    }

    // Has the quiet period at the current rung elapsed?
    const lastEscalation = event.escalations?.[event.escalations.length - 1];
    const since = lastEscalation ? new Date(lastEscalation.notifiedAt) : new Date(event.dueAt);
    const waited = (now.getTime() - since.getTime()) / DAY_MS;
    if (waited < (next.afterDays || 0)) {
      await event.save();
      continue;
    }

    // An acknowledged rung stops the climb — someone has picked it up.
    if (lastEscalation && lastEscalation.acknowledgedAt) {
      await event.save();
      continue;
    }

    const recipients = await resolveRecipients({
      ...event.toObject(),
      responsibleType: 'Role',
      responsibleRole: next.role,
      company: event.company,
    });

    const daysLate = Math.abs(daysUntil(event.dueAt, now));
    for (const recipient of recipients) {
      await notifications()
        .createAndEmit({
          recipientId: recipient.id,
          recipientType: 'admin',
          type: 'legal_escalation',
          title: `Escalated to ${next.role} — ${event.title}`,
          content:
            `This deadline passed ${daysLate} day(s) ago with no action recorded.\n` +
            `Due: ${new Date(event.dueAt).toDateString()}\n` +
            (event.kind === EVENT_KINDS.LIMITATION
              ? 'This was a statutory time-bar. The claim may no longer be capable of being brought.'
              : ''),
          claimId: event.claim,
        })
        .catch((err) => logger.error(`[legal-escalation] notify failed: ${err.message}`));
    }

    event.escalationRung = next.rung;
    event.escalations.push({ rung: next.rung, role: next.role, notifiedAt: now });
    escalated += 1;

    logger.warn(
      `[legal-escalation] event ${event._id} (${event.eventType}) escalated to rung ${next.rung} (${next.role}) — ` +
      `${daysLate} days overdue`
    );

    await event.save();
  }

  return { marked, escalated, scanned: overdue.length };
}

/**
 * Acknowledge an escalation, stopping the climb.
 */
async function acknowledge(eventId, actor) {
  const event = await LegalEvent.findById(eventId);
  if (!event) return null;
  const last = event.escalations?.[event.escalations.length - 1];
  if (last && !last.acknowledgedAt) {
    last.acknowledgedAt = new Date();
    last.acknowledgedBy = actor?._id || actor?.id || null;
    await event.save();
  }
  return event;
}

module.exports = {
  runDiaryReminders,
  runLimitationSweep,
  runOverdueEscalation,
  acknowledge,
  dueOffsets,
  daysUntil,
  resolveRecipients,
};
