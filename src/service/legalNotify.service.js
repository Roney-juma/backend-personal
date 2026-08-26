const notificationService = require('./notification.service');
const { sendEmailNotification } = require('./email.service');
const Users = require('../models/users.model');
const Role = require('../models/roles.model');
const Advocate = require('../models/advocate.model');
const logger = require('../middlewheres/logger');

/**
 * Every notification the Legal module sends goes through here.
 *
 * Why a wrapper rather than calling the existing services directly:
 *
 *   notificationService.createAndEmit()  →  in-app + Socket.IO + push + WhatsApp
 *   emailService.sendEmailNotification() →  email + WhatsApp mirror
 *
 * Calling both — which is what "email and WhatsApp" naively requires — sends the
 * recipient TWO WhatsApp messages for one event. This service composes them
 * correctly: createAndEmit handles in-app, push and WhatsApp, then the email is
 * sent with the mirror explicitly suppressed.
 *
 * The other reason it exists: legal notifications go to ROLES far more often
 * than to named people. "Warn the Legal Officers" and "escalate to the Head of
 * Claims" are the normal cases, and resolving a role to its current holders is
 * not something individual call sites should each reimplement.
 */

/**
 * Send one legal notification across every channel the recipient can receive.
 *
 * @param {Object} params
 * @param {Object} params.to          { id, type, email, name } — type is 'admin' (staff) or 'advocate'
 * @param {string} params.type        notification type slug, e.g. 'legal_time_bar'
 * @param {string} params.title
 * @param {string} params.body
 * @param {*}      [params.claimId]
 * @param {Object} [params.channels]  { inApp, email, whatsapp, push } — all true by default
 * @returns {Promise<{ inApp: boolean, email: boolean }>}
 */
async function send({ to, type, title, body, claimId, channels = {} }) {
  const want = { inApp: true, email: true, whatsapp: true, push: true, ...channels };
  const result = { inApp: false, email: false };

  if (!to?.id && !to?.email) {
    logger.warn(`[legal-notify] ${type}: no recipient id or email — nothing sent`);
    return result;
  }

  // In-app + Socket.IO + push + WhatsApp.
  if (want.inApp && to.id) {
    try {
      await notificationService.createAndEmit({
        recipientId: to.id,
        recipientType: to.type === 'advocate' ? 'advocate' : 'admin',
        type,
        title,
        content: body,
        claimId,
        // createAndEmit resolves the number itself from the recipient model; if
        // the caller asked for no WhatsApp we pass a blank so nothing is sent.
        ...(want.whatsapp ? {} : { whatsappNumber: null }),
      });
      result.inApp = true;
    } catch (err) {
      logger.error(`[legal-notify] in-app failed for ${type}: ${err.message}`);
    }
  }

  // Email. WhatsApp is suppressed here because createAndEmit already sent it —
  // without this flag every legal notification arrives on WhatsApp twice.
  if (want.email && to.email) {
    try {
      await sendEmailNotification(to.email, title, body, {
        whatsapp: want.inApp && to.id ? false : want.whatsapp,
      });
      result.email = true;
    } catch (err) {
      logger.error(`[legal-notify] email failed for ${type} to ${to.email}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Send the same notification to everyone currently holding a role in a tenant.
 *
 * Legal work is assigned to roles far more often than to individuals — a
 * time-bar on an unassigned claim belongs to "the Legal Officers", not to
 * whoever happened to register it.
 *
 * @param {Object} params
 * @param {*}        params.company
 * @param {string[]} params.roles     role names, e.g. ['Legal Officer']
 * @param {number}   [params.limit=20]
 */
async function sendToRoles({ company, roles, type, title, body, claimId, channels, limit = 20 }) {
  const roleDocs = await Role.find({ company, name: { $in: roles } }).select('_id').lean();
  if (!roleDocs.length) {
    logger.warn(
      `[legal-notify] ${type}: no role named ${roles.join(' / ')} exists for company ${company} — ` +
      'nobody was notified. Run scripts/seed-roles.js.'
    );
    return { notified: 0 };
  }

  const users = await Users.find({
    company,
    role: { $in: roleDocs.map((r) => r._id) },
    active: true,
  })
    .select('fullName email phone')
    .limit(limit)
    .lean();

  if (!users.length) {
    logger.warn(`[legal-notify] ${type}: role ${roles.join(' / ')} exists but nobody holds it`);
    return { notified: 0 };
  }

  let notified = 0;
  for (const user of users) {
    const r = await send({
      to: { id: user._id, type: 'admin', email: user.email, name: user.fullName },
      type,
      title,
      body,
      claimId,
      channels,
    });
    if (r.inApp || r.email) notified += 1;
  }

  return { notified, recipients: users.map((u) => u.email) };
}

/** Notify a single member of staff by id. */
async function sendToUser({ userId, type, title, body, claimId, channels }) {
  const user = await Users.findById(userId).select('fullName email phone').lean();
  if (!user) return { notified: 0 };

  const r = await send({
    to: { id: user._id, type: 'admin', email: user.email, name: user.fullName },
    type, title, body, claimId, channels,
  });
  return { notified: r.inApp || r.email ? 1 : 0 };
}

/** Notify a panel advocate. */
async function sendToAdvocate({ advocateId, type, title, body, claimId, channels }) {
  const advocate = await Advocate.findById(advocateId).select('name email phone').lean();
  if (!advocate) return { notified: 0 };

  const r = await send({
    to: { id: advocate._id, type: 'advocate', email: advocate.email, name: advocate.name },
    type, title, body, claimId, channels,
  });
  return { notified: r.inApp || r.email ? 1 : 0 };
}

/**
 * Message bodies for the module's events.
 *
 * Kept together so the tone stays consistent and so the wording that actually
 * matters — a time-bar warning — is written once and reviewed, rather than
 * improvised at eight call sites. Every body is plain text: it has to read
 * correctly in an email, in a WhatsApp message and in an in-app card.
 */
const templates = {
  timeBar: ({ reference, party, daysLeft, expiresAt }) => ({
    title:
      daysLeft < 0
        ? `TIME-BARRED — ${reference}`
        : `Time-bar in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ${reference}`,
    body:
      `Third-party claim ${reference}${party ? ` (${party})` : ''} ` +
      (daysLeft < 0
        ? `passed its limitation date on ${fmt(expiresAt)}. The claim can no longer be brought.`
        : `reaches its limitation date on ${fmt(expiresAt)}.`) +
      (daysLeft >= 0 && daysLeft <= 30
        ? '\n\nIf a suit is to be filed, it must be filed now.'
        : ''),
  }),

  deadline: ({ title, dueAt, daysLeft, caseNumber, court }) => ({
    title: `${title} — ${daysLeft < 0 ? `${Math.abs(daysLeft)} days overdue` : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}`,
    body:
      `${title}\nDue: ${fmt(dueAt)}` +
      (caseNumber ? `\nMatter: ${caseNumber}` : '') +
      (court ? `\nCourt: ${court}` : ''),
  }),

  escalation: ({ title, dueAt, daysLate, role, isLimitation }) => ({
    title: `Escalated to ${role} — ${title}`,
    body:
      `${title}\nDue: ${fmt(dueAt)}\n\nThis passed ${daysLate} day${daysLate === 1 ? '' : 's'} ago with no ` +
      'action recorded.' +
      (isLimitation ? '\n\nThis was a statutory time-bar. The claim may no longer be capable of being brought.' : ''),
  }),

  approvalRequired: ({ reference, amount, party, approver, reserve }) => ({
    title: `Approval needed — ${amount}`,
    body:
      `Settlement ${reference}${party ? ` for ${party}` : ''} of ${amount} requires ${approver}.` +
      (reserve ? `\nReserved: ${reserve}` : '') +
      '\n\nOpen the approval queue in AVICS to approve, reject or escalate.',
  }),

  approvalDecided: ({ reference, decision, amount, by, notes }) => ({
    title: `Settlement ${decision} — ${reference}`,
    body:
      `Settlement ${reference} of ${amount} was ${decision}${by ? ` by ${by}` : ''}.` +
      (notes ? `\n\n${notes}` : ''),
  }),

  counselAppointed: ({ caseNumber, court, courtCase, instructions }) => ({
    title: `You have been instructed — ${courtCase || caseNumber}`,
    body:
      `You have been appointed on ${courtCase || caseNumber}${court ? ` in ${court}` : ''}.` +
      (instructions ? `\n\n${instructions}` : '') +
      '\n\nSign in to the AVE partner portal to accept instructions and download the papers.',
  }),

  authorityRequested: ({ caseNumber, amount, advocate, rationale }) => ({
    title: `Counsel requests authority — ${amount}`,
    body:
      `${advocate || 'Counsel'} requests settlement authority of ${amount} on ${caseNumber}.` +
      (rationale ? `\n\n${rationale}` : '') +
      '\n\nThis is a recommendation. It becomes a proposal only when a Legal Officer adopts it.',
  }),

  /**
   * Counsel has concluded a matter. Where an appeal is advised the deadline
   * leads the message — it is the one thing here that expires.
   */
  closingReportSubmitted: ({ caseNumber, advocate, outcome, summary, appealAdvised, appealDeadline }) => ({
    title: appealAdvised
      ? `Closing report — APPEAL ADVISED on ${caseNumber}`
      : `Closing report received — ${caseNumber}`,
    body:
      `${advocate || 'Counsel'} has concluded ${caseNumber}: ${outcome}.` +
      (appealAdvised
        ? `\n\nAN APPEAL IS ADVISED. The window closes ${
            appealDeadline ? new Date(appealDeadline).toDateString() : 'shortly'
          } — a decision is needed before then.`
        : '') +
      (summary ? `\n\n${summary}` : '') +
      '\n\nThe matter is not closed. Review the report and run the closure checklist.',
  }),

  progressReportOverdue: ({ caseNumber, courtCase, days, court }) => ({
    title: `Progress report overdue — ${courtCase || caseNumber}`,
    body:
      `No progress report has been received for ${days} days on ${courtCase || caseNumber}` +
      (court ? ` (${court})` : '') + '.\n\nPlease submit one through the partner portal.',
  }),

  referralRaised: ({ reference, claimRef, reason, urgency, raisedBy }) => ({
    title: `${urgency === 'high' ? 'URGENT: ' : ''}Legal referral — ${reference}`,
    body:
      `A claim has been referred to Legal${raisedBy ? ` by ${raisedBy}` : ''}.` +
      (claimRef ? `\nClaim: ${claimRef}` : '') +
      `\nReason: ${reason}` +
      (urgency ? `\nUrgency: ${urgency}` : '') +
      '\n\nOpen Legal referrals in AVICS to accept or return it.',
  }),

  referralDecided: ({ reference, decision, by, notes }) => ({
    title: `Referral ${decision} — ${reference}`,
    body:
      `Your legal referral ${reference} was ${decision}${by ? ` by ${by}` : ''}.` +
      (notes ? `\n\n${notes}` : ''),
  }),

  autoReferred: ({ reference, claimRef, trigger }) => ({
    title: `Auto-referred to Legal — ${claimRef || reference}`,
    body:
      `This claim was referred to Legal automatically.\nTrigger: ${trigger}` +
      '\n\nIt is waiting in Legal referrals for review.',
  }),

  /**
   * Panel access notice. Deliberately carries no password — see
   * `portalAccessEmail` below for why the two are separate.
   */
  portalAccess: ({ name, insurer }) => ({
    title: 'Your panel portal access is ready',
    body:
      `${name}, portal access has been issued for you${insurer ? ` on ${insurer}'s panel` : ''}.\n\n` +
      'Your temporary password has been emailed to you separately. You will be asked to change it ' +
      'when you first sign in.',
  }),

  /**
   * The email that carries the temporary password.
   *
   * Sent by email ALONE. A password that also goes out over WhatsApp sits in a
   * chat history on a phone that may be shared, forwarded or backed up — and
   * these credentials open privileged case files.
   */
  portalAccessEmail: ({ name, email, password }) => ({
    title: 'Your AVICS panel portal password',
    body:
      `${name},\n\nPortal access has been issued for you.\n\n` +
      `Username: ${email}\nTemporary password: ${password}\n\n` +
      'You will be required to change this password when you first sign in. ' +
      'Do not forward this message.',
  }),
};

const fmt = (d) => (d ? new Date(d).toDateString() : 'an unspecified date');

module.exports = { send, sendToRoles, sendToUser, sendToAdvocate, templates };
