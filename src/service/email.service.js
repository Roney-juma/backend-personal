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

const sendEmailNotification = (to, subject, text) => {
  const mailOptions = { from: process.env.EMAIL_HOST_USER, to, subject, text };
  return transporter.sendMail(mailOptions).then((info) => {
    logger.info('Email sent to %s: %s', to, info.response);
  }).catch((error) => {
    logger.error('Error sending email to %s: %s', to, error.message);
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
    logger.error('Error sending invoice email to %s: %s', to, error.message);
  });
};

module.exports = { sendEmailNotification, sendInvoiceEmail };
