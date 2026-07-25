const crypto = require('crypto');
const OtpCode = require('../models/otpCode.model');
const ApiError = require('../utils/ApiError');
const emailService = require('./email.service');
const whatsappService = require('./whatsapp.service');

// Contract §2.4: 6 digits, hashed at rest, 10-minute validity, max 5 verify
// attempts per code, 60 s resend cooldown, max 5 sends/hour per destination.
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

const apiError = (statusCode, code, message) => {
  const err = new ApiError(statusCode, message);
  err.code = code;
  return err;
};

// Generate + persist + deliver a fresh code. Any previous live code for the
// same (customer, purpose) is invalidated (expiresAt forced to now) rather than
// deleted, so it keeps counting toward the hourly send limit until TTL purge.
const issueCode = async ({ customer, channel, destination, purpose = 'activation' }) => {
  const now = Date.now();

  const lastIssued = await OtpCode.findOne({ customerId: customer._id, purpose })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();
  if (lastIssued && now - new Date(lastIssued.createdAt).getTime() < RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - (now - new Date(lastIssued.createdAt).getTime())) / 1000);
    throw apiError(429, 'OTP_COOLDOWN', `Please wait ${waitSeconds} second(s) before requesting another code.`);
  }

  const sendsLastHour = await OtpCode.countDocuments({
    destination,
    createdAt: { $gte: new Date(now - 60 * 60 * 1000) },
  });
  if (sendsLastHour >= MAX_SENDS_PER_HOUR) {
    throw apiError(429, 'OTP_RATE_LIMITED', 'Too many codes requested. Please try again in an hour.');
  }

  // One live code per (customer, purpose): supersede anything still pending.
  await OtpCode.updateMany(
    { customerId: customer._id, purpose, consumedAt: null },
    { $set: { expiresAt: new Date(now) } }
  );

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await OtpCode.create({
    company: customer.company?._id || customer.company,
    customerId: customer._id,
    channel,
    destination,
    codeHash: hashCode(code),
    purpose,
    expiresAt: new Date(now + OTP_TTL_MS),
  });

  const message = `Your AVE verification code is ${code}. It expires in 10 minutes. If you did not request this, please ignore this message.`;
  if (channel === 'email') {
    await emailService.sendEmailNotification(destination, 'Your AVE verification code', message);
  } else {
    await whatsappService.sendWhatsAppMessage(destination, message);
  }

  return { channel, destination, resendAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000) };
};

// Check a submitted code against the customer's current live code.
// Returns the (now consumed) OtpCode document on success.
const verifyCode = async ({ customerId, code, purpose = 'activation' }) => {
  const doc = await OtpCode.findOne({ customerId, purpose, consumedAt: null })
    .sort({ createdAt: -1 });

  if (!doc) {
    throw apiError(400, 'INVALID_CODE', 'The verification code is incorrect.');
  }
  if (doc.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw apiError(429, 'TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Please request a new code.');
  }
  if (new Date(doc.expiresAt).getTime() <= Date.now()) {
    throw apiError(400, 'EXPIRED_CODE', 'The verification code has expired. Please request a new one.');
  }

  if (doc.codeHash !== hashCode(code)) {
    // Atomic increment so parallel guesses cannot dodge the attempt cap.
    const updated = await OtpCode.findOneAndUpdate(
      { _id: doc._id },
      { $inc: { attempts: 1 } },
      { new: true }
    );
    if (updated && updated.attempts >= MAX_VERIFY_ATTEMPTS) {
      // Invalidate the code outright (contract §2.4) — a new one must be requested.
      await OtpCode.updateOne({ _id: doc._id }, { $set: { expiresAt: new Date() } });
      throw apiError(429, 'TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Please request a new code.');
    }
    throw apiError(400, 'INVALID_CODE', 'The verification code is incorrect.');
  }

  // Race-safe consume: only one concurrent verify can win this update.
  const consumed = await OtpCode.findOneAndUpdate(
    { _id: doc._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!consumed) {
    throw apiError(400, 'INVALID_CODE', 'The verification code is incorrect.');
  }
  return consumed;
};

module.exports = { issueCode, verifyCode, MAX_VERIFY_ATTEMPTS };
