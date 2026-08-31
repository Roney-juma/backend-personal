const emailService = require('./email.service');
const logger = require('../middlewheres/logger');
const { formatDateTime, formatShortDate } = require('../utils/timezone');

/**
 * Email notifications for the internal workspace (meetings + tasks).
 *
 * Every export here is fire-and-forget by contract: callers invoke them WITHOUT
 * awaiting, and each one swallows its own failures into a warning. A mail outage
 * must never fail the request that scheduled the meeting or assigned the task.
 *
 * Note that `sendEmailNotification` also mirrors to WhatsApp where a phone can be
 * resolved for the address — that behaviour is centralised there on purpose, so
 * nothing extra is needed (or wanted) here.
 */

const APP_NAME = 'AVICS';

/**
 * Rendered in the business timezone, NOT the server's. Production runs on UTC,
 * so a bare toLocaleString reported a 14:00 Nairobi meeting as 11:00 — in the
 * WhatsApp mirror and the email alike, since both read this same string.
 */
const fmtWhen = (date) => formatDateTime(date) || 'TBC';

/** Where the meeting happens, in one line, whatever the format. */
const fmtWhere = (meeting) => {
  if (meeting.format === 'in_person') return meeting.location || 'In person — location TBC';
  const link = meeting.meetingLink ? `Online — ${meeting.meetingLink}` : 'Online — link to follow';
  if (meeting.format === 'hybrid') return `${meeting.location || 'In person — location TBC'} / ${link}`;
  return link;
};

const agendaBlock = (meeting) => {
  const items = (meeting.agenda ?? []).filter((a) => a.item);
  if (items.length === 0) return '';
  const lines = items.map((a, i) => `  ${i + 1}. ${a.item}${a.presenterName ? ` (${a.presenterName})` : ''}`);
  return `\nAgenda:\n${lines.join('\n')}\n`;
};

/**
 * Everyone who should receive mail about a meeting, deduplicated by address.
 *
 * "Attendees" is broader than the attendees array: the client contact person is
 * who the meeting is *with* and is rarely also typed in as a guest, and the
 * organiser needs their own copy — otherwise a session booked for two other
 * people leaves the person who arranged it with no record of it.
 *
 * Addresses we do not have are skipped silently; a named attendee with no email
 * is a display detail, not an error.
 */
const recipientsOf = (meeting, { excludeEmail } = {}) => {
  const seen = new Set();
  const out = [];

  const add = (email, name) => {
    if (!email) return;
    const key = String(email).trim().toLowerCase();
    if (!key) return;
    if (key === String(excludeEmail ?? '').trim().toLowerCase()) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email, name });
  };

  (meeting.attendees ?? []).forEach((a) => {
    // A populated staff attendee carries the address on the user document.
    add(a.email || (a.user && typeof a.user === 'object' ? a.user.email : null), a.name);
  });

  // The client contact — the whole point of a client-facing session.
  add(meeting.client?.contactEmail, meeting.client?.contactName || meeting.client?.name);

  // The organiser's own copy. Deduplicated above if they are also an attendee.
  add(
    meeting.organiser && typeof meeting.organiser === 'object' ? meeting.organiser.email : null,
    meeting.organiserName,
  );

  return out;
};

/** Send one email per recipient, never rejecting. Returns how many were sent. */
const fanOut = async (recipients, subject, bodyFor, context) => {
  if (recipients.length === 0) return 0;
  const results = await Promise.allSettled(
    recipients.map((r) => emailService.sendEmailNotification(r.email, subject, bodyFor(r))),
  );
  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      logger.warn(`[workspaceNotify] ${context} email failed | to=${recipients[i].email} | ${res.reason?.message}`);
    }
  });
  return results.filter((r) => r.status === 'fulfilled').length;
};

/**
 * New meeting on the calendar — invite everyone with an address.
 * For a recurring series this is called ONCE with `seriesCount`, so attendees
 * get a single invitation naming the cadence rather than one mail per occurrence.
 */
const meetingScheduled = async (meeting, { seriesCount } = {}) => {
  const recipients = recipientsOf(meeting);
  const subject = `Meeting invitation: ${meeting.title}`;
  const repeats =
    seriesCount && seriesCount > 1
      ? `Repeats: ${meeting.recurrence?.frequency ?? 'recurring'} — ${seriesCount} occurrences, first shown above\n`
      : '';
  const body = (r) =>
    `Hello ${r.name || 'there'},\n\n` +
    `You have been invited to a meeting.\n\n` +
    `What:  ${meeting.title}\n` +
    `When:  ${fmtWhen(meeting.startAt)}${meeting.durationMinutes ? ` (${meeting.durationMinutes} minutes)` : ''}\n` +
    `Where: ${fmtWhere(meeting)}\n` +
    `Organiser: ${meeting.organiserName || 'AVE Africa'}\n` +
    repeats +
    (meeting.purpose ? `\nPurpose:\n${meeting.purpose}\n` : '') +
    agendaBlock(meeting) +
    `\nReference: ${meeting.reference}\n\n` +
    `— ${APP_NAME}`;

  const sent = await fanOut(recipients, subject, body, 'meetingScheduled');
  logger.info(`[workspaceNotify] meeting ${meeting.reference} invitations sent | ${sent}/${recipients.length}`);
};

/** Time, location or format moved — tell people what changed. */
const meetingUpdated = async (meeting, changes = []) => {
  const recipients = recipientsOf(meeting);
  const subject = `Updated: ${meeting.title}`;
  const changeLines = changes.length ? `\nWhat changed:\n${changes.map((c) => `  - ${c}`).join('\n')}\n` : '';
  const body = (r) =>
    `Hello ${r.name || 'there'},\n\n` +
    `A meeting on your calendar has been updated.\n` +
    changeLines +
    `\nWhat:  ${meeting.title}\n` +
    `When:  ${fmtWhen(meeting.startAt)}\n` +
    `Where: ${fmtWhere(meeting)}\n` +
    `\nReference: ${meeting.reference}\n\n` +
    `— ${APP_NAME}`;

  await fanOut(recipients, subject, body, 'meetingUpdated');
};

const meetingCancelled = async (meeting) => {
  const recipients = recipientsOf(meeting);
  const subject = `Cancelled: ${meeting.title}`;
  const body = (r) =>
    `Hello ${r.name || 'there'},\n\n` +
    `The following meeting has been cancelled.\n\n` +
    `What: ${meeting.title}\n` +
    `When: ${fmtWhen(meeting.startAt)}\n` +
    (meeting.cancelledReason ? `\nReason: ${meeting.cancelledReason}\n` : '') +
    `\nReference: ${meeting.reference}\n\n` +
    `— ${APP_NAME}`;

  await fanOut(recipients, subject, body, 'meetingCancelled');
};

/** Minutes published after a session is closed out. */
const meetingMinutes = async (meeting, actionItems = []) => {
  const recipients = recipientsOf(meeting);
  const decisions = (meeting.decisions ?? []).map((d) => `  - ${d.text}`).join('\n');
  const actions = actionItems
    .map((i) => `  - ${i.title} (${i.assigneeName || 'unassigned'}${i.dueAt ? `, due ${formatShortDate(i.dueAt)}` : ''})`)
    .join('\n');

  const subject = `Minutes: ${meeting.title}`;
  const body = (r) =>
    `Hello ${r.name || 'there'},\n\n` +
    `Here is the record of ${meeting.title} held on ${fmtWhen(meeting.startAt)}.\n` +
    (meeting.outcome ? `\nOutcome: ${meeting.outcome}\n` : '') +
    (meeting.minutes ? `\nNotes:\n${meeting.minutes}\n` : '') +
    (decisions ? `\nDecisions:\n${decisions}\n` : '') +
    (actions ? `\nAction items:\n${actions}\n` : '') +
    `\nReference: ${meeting.reference}\n\n` +
    `— ${APP_NAME}`;

  await fanOut(recipients, subject, body, 'meetingMinutes');
};

/**
 * Task assigned to someone. `assigneeEmail` is resolved by the caller, which
 * already has the populated document.
 */
const taskAssigned = async (task, assigneeEmail, assigneeName) => {
  if (!assigneeEmail) return;
  const subject = `Assigned to you: ${task.reference} — ${task.title}`;
  const body =
    `Hello ${assigneeName || 'there'},\n\n` +
    `An task has been assigned to you.\n\n` +
    `Reference: ${task.reference}\n` +
    `Title:     ${task.title}\n` +
    `Type:      ${task.type}\n` +
    `Priority:  ${task.priority}\n` +
    `Area:      ${task.area}\n` +
    (task.dueAt ? `Due:       ${formatShortDate(task.dueAt)}\n` : '') +
    (task.description ? `\nDescription:\n${task.description}\n` : '') +
    (task.reporterName ? `\nRaised by: ${task.reporterName}\n` : '') +
    `\n— ${APP_NAME}`;

  try {
    await emailService.sendEmailNotification(assigneeEmail, subject, body);
  } catch (err) {
    logger.warn(`[workspaceNotify] taskAssigned email failed | to=${assigneeEmail} | ${err.message}`);
  }
};

/** Someone commented — tell the assignee and reporter, but never the author. */
const taskCommented = async (task, comment, recipients = []) => {
  const subject = `New comment on ${task.reference}: ${task.title}`;
  const body = (r) =>
    `Hello ${r.name || 'there'},\n\n` +
    `${comment.authorName || 'Someone'} commented on an task you are following.\n\n` +
    `${comment.body}\n\n` +
    `Reference: ${task.reference}\n` +
    `Title:     ${task.title}\n` +
    `Status:    ${task.status}\n\n` +
    `— ${APP_NAME}`;

  await fanOut(recipients, subject, body, 'taskCommented');
};

/** Task closed out — let the reporter know their item landed. */
const taskResolved = async (task, recipients = []) => {
  const subject = `Resolved: ${task.reference} — ${task.title}`;
  const body = (r) =>
    `Hello ${r.name || 'there'},\n\n` +
    `An task you are following has been marked ${task.status}.\n\n` +
    `Reference: ${task.reference}\n` +
    `Title:     ${task.title}\n` +
    (task.resolution ? `\nResolution:\n${task.resolution}\n` : '') +
    `\n— ${APP_NAME}`;

  await fanOut(recipients, subject, body, 'taskResolved');
};

module.exports = {
  // Exported so callers can report who will be contacted without sending, and
  // so the dedup/ordering rules are directly testable.
  recipientsOf,
  meetingScheduled,
  meetingUpdated,
  meetingCancelled,
  meetingMinutes,
  taskAssigned,
  taskCommented,
  taskResolved,
};
