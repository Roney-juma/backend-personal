/**
 * The timezone the business runs in.
 *
 * Everything is stored in UTC, which is correct — but anything a person READS
 * must be rendered in their zone, and the server's zone is not it. Production
 * runs on UTC EC2, so a bare `toLocaleString()` silently reports a 14:00
 * Nairobi meeting as 11:00. Nothing errors; the message is just wrong, which is
 * the worst kind of wrong for a calendar invitation.
 *
 * Reads the same CLAIM_TIMEZONE var the AI claim intake already uses, so an
 * insurer operating elsewhere sets it once.
 */
const APP_TZ = process.env.CLAIM_TIMEZONE || 'Africa/Nairobi';

/** "Thursday, 10 September 2026 at 14:00" in the business timezone. */
const formatDateTime = (value, locale = 'en-GB') =>
  value
    ? new Date(value).toLocaleString(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: APP_TZ,
        // Named so an external guest in another country is not left guessing.
        timeZoneName: 'short',
      })
    : null;

/** "10 September 2026" in the business timezone. */
const formatDate = (value, locale = 'en-GB') =>
  value
    ? new Date(value).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: APP_TZ,
      })
    : null;

/**
 * A date alone still needs the zone: a deadline stored at 21:30 UTC is the NEXT
 * day in Nairobi, so formatting it on the server's clock reports the wrong day.
 */
const formatShortDate = (value, locale = 'en-GB') =>
  value ? new Date(value).toLocaleDateString(locale, { timeZone: APP_TZ }) : null;

module.exports = { APP_TZ, formatDateTime, formatDate, formatShortDate };
