const nodemailer = require('nodemailer');
const logger = require('../middlewheres/logger');
const { getQueue } = require('../queue/queues');
const { getCorrelationId } = require('../utils/requestContext');
const whatsappService = require('./whatsapp.service');
const findPhoneByEmail = require('../utils/findPhoneByEmail');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT, 10),
  secure: process.env.EMAIL_PORT === '465',
  auth: {
    user: process.env.EMAIL_HOST_USER,
    pass: process.env.EMAIL_HOST_PASSWORD,
  },
});

const logEmailError = (to, error) => {
  logger.error(`Email failed | to=${to} | ${error.message} | code=${error.code || 'N/A'} | response=${error.response || 'N/A'}`);
};

// Direct send — called by the worker (and as fallback when Redis is unavailable)
const sendEmailDirect = (to, subject, text) => {
  const mailOptions = { from: process.env.EMAIL_HOST_USER, to, subject, text };
  return transporter.sendMail(mailOptions)
    .then((info) => logger.info(`Email sent | to=${to} | ${info.response}`))
    .catch((error) => logEmailError(to, error));
};

// Condense an email body into a concise line suited to the WhatsApp template's
// single {{1}} variable: drop the "Dear …," greeting and the sign-off boilerplate
// ("Best Regards / Admin Team / Thank you for choosing …"), collapse whitespace,
// and cap the length. The important middle (codes, links, the actual message) is
// kept. The subject becomes a bold headline. WhatsApp renders *bold*.
const WA_MAX = 700;
const toWhatsAppText = (subject, text) => {
  let body = String(text || '')
    // strip a leading greeting line: "Dear Jane," / "Hi Jane" / "Hello,"
    .replace(/^\s*(dear|hi|hello)\b[^\n]*\n+/i, '')
    // strip everything from a sign-off onwards
    .replace(
      /\n+\s*(best regards|kind regards|regards|warm regards|sincerely|thanks|thank you for choosing|the ave[^\n]*team|ave insurance team|admin team|ave africa[^\n]*)\b[\s\S]*$/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();

  const head = subject ? `*${String(subject).trim()}*` : '';
  const msg = [head, body].filter(Boolean).join(' — ');
  return msg.length > WA_MAX ? `${msg.slice(0, WA_MAX - 1).trimEnd()}…` : msg;
};

// Mirror an email notification to WhatsApp. Every email is also sent over WhatsApp
// to the same recipient (resolved from their email → phone), so a notification is
// never email-only. Best-effort and de-duplicated per request by whatsapp.service,
// so a flow that already sends an explicit WhatsApp won't double-send.
//   opts.whatsapp === false → skip the mirror (e.g. an email that must stay email-only)
//   opts.phone             → use this number instead of an email→phone lookup
//   opts.whatsappText      → send this exact WhatsApp text instead of a condensed
//                            version of the email body
const mirrorToWhatsApp = async (to, subject, text, opts) => {
  if (opts && opts.whatsapp === false) return;
  try {
    const phone = (opts && opts.phone) || (await findPhoneByEmail(to));
    if (!phone) return;
    const message = (opts && opts.whatsappText) || toWhatsAppText(subject, text);
    if (!message) return;
    await whatsappService.sendWhatsAppMessage(phone, message);
  } catch (err) {
    logger.warn(`WhatsApp mirror failed | to=${to} | ${err.message}`);
  }
};

// Enqueued send — all services call this; falls back to direct if Redis not available or queue fails
const sendEmailNotification = async (to, subject, text, opts = {}) => {
  const queue = getQueue();
  if (queue) {
    try {
      await queue.add('email', { to, subject, text, correlationId: getCorrelationId() });
      await mirrorToWhatsApp(to, subject, text, opts);
      return;
    } catch (err) {
      logger.warn(`Email queue failed, falling back to direct send | to=${to} | ${err.message}`);
    }
  }
  await sendEmailDirect(to, subject, text);
  await mirrorToWhatsApp(to, subject, text, opts);
};

// Invoice email always sent directly — attachment serialisation overhead not worth it
const sendInvoiceEmail = (to, subject, text, pdfBuffer, filename) => {
  const mailOptions = {
    from: process.env.EMAIL_HOST_USER,
    to,
    subject,
    text,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  };
  return transporter.sendMail(mailOptions)
    .then((info) => logger.info(`Invoice email sent | to=${to} | ${info.response}`))
    .catch((error) => logEmailError(to, error));
};

// Startup health-check: confirms the SMTP host/credentials are usable so a
// misconfiguration is caught in the logs immediately, instead of silently
// failing on every queued send. Never throws — logs and resolves to a boolean.
const verifyTransport = async () => {
  try {
    await transporter.verify();
    logger.info(`SMTP ready | host=${process.env.EMAIL_HOST} port=${process.env.EMAIL_PORT} user=${process.env.EMAIL_HOST_USER}`);
    return true;
  } catch (error) {
    logger.error(`SMTP verify FAILED | host=${process.env.EMAIL_HOST} port=${process.env.EMAIL_PORT} | ${error.message} | code=${error.code || 'N/A'}`);
    return false;
  }
};

module.exports = { sendEmailNotification, sendEmailDirect, sendInvoiceEmail, verifyTransport };
