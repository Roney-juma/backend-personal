const nodemailer = require('nodemailer');
require("dotenv").config();


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_HOST_USER, 
    pass: process.env.EMAIL_HOST_PASSWORD,
  },
});

const sendEmailNotification = (to, subject, text) => {
  const mailOptions = { from: process.env.EMAIL_HOST_USER, to, subject, text };
  return transporter.sendMail(mailOptions).then((info) => {
    console.log('Email sent:', info.response);
  }).catch((error) => {
    console.error('Error sending email:', error);
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
    console.log('Invoice email sent:', info.response);
  }).catch((error) => {
    console.error('Error sending invoice email:', error);
  });
};

module.exports = { sendEmailNotification, sendInvoiceEmail };