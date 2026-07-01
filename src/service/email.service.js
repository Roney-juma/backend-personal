const nodemailer = require('nodemailer');
const logger = require('../middlewheres/logger');
const { getQueue } = require('../queue/queues');
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

// Enqueued send — all services call this; falls back to direct if Redis not available or queue fails
const sendEmailNotification = async (to, subject, text) => {
  const queue = getQueue();
  if (queue) {
    try {
      await queue.add('email', { to, subject, text });
      return;
    } catch (err) {
      logger.warn(`Email queue failed, falling back to direct send | to=${to} | ${err.message}`);
    }
  }
  await sendEmailDirect(to, subject, text);
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

module.exports = { sendEmailNotification, sendEmailDirect, sendInvoiceEmail };
