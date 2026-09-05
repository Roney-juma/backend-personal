const Meeting = require('../models/meeting.model');
const notify = require('./workspaceNotify.service');
const logger = require('../middlewheres/logger');

/**
 * "Your meeting starts in half an hour."
 *
 * The invitation goes out when the meeting is booked, which for something
 * arranged three weeks ahead is far too early to be the thing that gets anyone
 * into the room. This is the nudge on the day.
 *
 * IDEMPOTENT, per the contract in queue/scheduler.js: the sweep runs every five
 * minutes and BullMQ retries a failed job three times, so an offset already
 * recorded in `meeting.remindersSent` is never sent again. The record is written
 * on the document, not held in the job.
 */

/**
 * How far ahead to remind, in minutes. A list rather than a constant because
 * adding a day-before nudge later should be one number here and nothing else —
 * the sweep already handles "which of these are due and unsent".
 */
const REMINDER_OFFSETS = [30];

/**
 * The window a sweep is responsible for.
 *
 * The job runs every five minutes, so each run must cover the five minutes that
 * have elapsed since the last one — otherwise a meeting whose 30-minute mark
 * falls between two runs is never reminded at all. Slightly wider than the
 * interval on purpose: a late run should still catch what it missed rather than
 * silently skipping it.
 */
const SWEEP_WINDOW_MINUTES = 6;

/**
 * Offsets that are due for this meeting and have not been sent.
 *
 * "Due" means the meeting starts within the offset AND we are not so far past
 * the mark that the reminder is pointless — a worker that has been down for two
 * hours should not send "starting in 30 minutes" about a meeting that began
 * ninety minutes ago. Past that, the meeting itself is the reminder.
 */
const dueOffsets = (meeting, now = new Date()) => {
  const minutesUntil = (new Date(meeting.startAt).getTime() - now.getTime()) / 60000;
  const sent = new Set((meeting.remindersSent || []).map((r) => r.offsetMinutes));

  return REMINDER_OFFSETS.filter((offset) => {
    if (sent.has(offset)) return false;
    // Inside the window that opens at the offset and closes when the sweep's
    // reach runs out.
    return minutesUntil <= offset && minutesUntil > offset - SWEEP_WINDOW_MINUTES;
  });
};

/**
 * Send the reminders that are due right now.
 *
 * Only meetings that are still going ahead: a cancelled one must never chase
 * people, and a completed one has already happened. Cheap to run — the query is
 * bounded by a narrow time window, so the sweep touches a handful of documents
 * however large the calendar gets.
 */
const runMeetingReminders = async ({ now = new Date() } = {}) => {
  const widest = Math.max(...REMINDER_OFFSETS);
  const horizon = new Date(now.getTime() + widest * 60000);

  const candidates = await Meeting.find({
    status: 'scheduled',
    startAt: { $gt: new Date(now.getTime() - SWEEP_WINDOW_MINUTES * 60000), $lte: horizon },
  }).populate([
    { path: 'organiser', select: 'fullName email phone' },
    { path: 'attendees.user', select: 'fullName email phone' },
  ]);

  let reminded = 0;
  let unreachable = 0;

  for (const meeting of candidates) {
    for (const offset of dueOffsets(meeting, now)) {
      const recipients = notify.recipientsOf(meeting);
      if (recipients.length === 0) {
        // Recorded anyway. Without this the sweep would reconsider this meeting
        // every five minutes until it starts, and log the same nothing each
        // time — a meeting with no addresses is a fact, not a retryable failure.
        unreachable += 1;
        logger.info(`[meeting] ${meeting.reference} reminder skipped — no attendee has an email address`);
      } else {
        try {
          await notify.meetingReminder(meeting, recipients, { minutesBefore: offset });
          reminded += 1;
        } catch (err) {
          // Leave the offset unrecorded so the next sweep retries it — there are
          // several more before the meeting starts.
          logger.warn(`[meeting] ${meeting.reference} reminder failed: ${err.message}`);
          continue;
        }
      }

      // Written only after the send, so a crash mid-send retries rather than
      // marking a reminder nobody received. $push, not save(), to avoid
      // clobbering a concurrent edit to the rest of the document.
      await Meeting.updateOne(
        { _id: meeting._id },
        { $push: { remindersSent: { offsetMinutes: offset, sentAt: new Date(), recipients: recipients.length } } },
      );
    }
  }

  if (reminded > 0 || unreachable > 0) {
    logger.info(`[meeting] reminder sweep | sent=${reminded} unreachable=${unreachable} scanned=${candidates.length}`);
  }
  return { reminded, unreachable, scanned: candidates.length };
};

module.exports = { runMeetingReminders, dueOffsets, REMINDER_OFFSETS, SWEEP_WINDOW_MINUTES };
