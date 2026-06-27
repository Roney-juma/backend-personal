const nodemailer = require('nodemailer');
const logger = require('../middlewheres/logger');
require("dotenv").config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT, 10),
  secure: process.env.EMAIL_PORT === '465',
  auth: {
    user: process.env.EMAIL_HOST_USER,
    pass: process.env.EMAIL_HOST_PASSWORD,
  },
});

const logEmailError = (label, to, error) => {
  logger.error('%s | to=%s | message=%s | code=%s | responseCode=%s | response=%s',
    label, to, error.message, error.code || 'N/A', error.responseCode || 'N/A', error.response || 'N/A');
};

const sendEmailNotification = (to, subject, text) => {
  const mailOptions = { from: process.env.EMAIL_HOST_USER, to, subject, text };
  return transporter.sendMail(mailOptions).then((info) => {
    logger.info('Email sent to %s: %s', to, info.response);
  }).catch((error) => {
    logEmailError('Error sending email', to, error);
  });
};

const sendInvoiceEmail = (to, subject, text, pdfBuffer, filename) => {
  const mailOptions = {
    from: process.env.EMAIL_HOST_USER,
    to,
    subject,
    text,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  };
  return transporter.sendMail(mailOptions).then((info) => {
    logger.info('Invoice email sent to %s: %s', to, info.response);
  }).catch((error) => {
    logEmailError('Error sending invoice email', to, error);
  });
};

module.exports = { sendEmailNotification, sendInvoiceEmail };
