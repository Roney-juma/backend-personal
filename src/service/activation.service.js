const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const Customer = require('../models/customerModel');
const InsuranceCompany = require('../models/insuranceCompany.model');
const CompanyActivity = require('../models/companyActivity.model');
const OtpCode = require('../models/otpCode.model');
const otpService = require('./otp.service');
const tokenService = require('./token.service');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const { assertValidPassword } = require('../utils/passwordPolicy');
const { TokenIssuer } = require('../constants/encryption.constants');
const { readPublicKey } = require('../config/keys');

const publicKey = readPublicKey();

const apiError = (statusCode, code, message) => {
  const err = new ApiError(statusCode, message);
  err.code = code;
  return err;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

// 'jane@x.com' -> 'j•••@x.com'
const maskEmail = (email) => {
  const [local, domain] = String(email).split('@');
  if (!domain) return '•••';
  return `${local.charAt(0)}•••@${domain}`;
};

// Keep the country code (+ first subscriber digit) and last 2 digits:
// '+254712345678' -> '+2547•••••78'
const maskPhone = (phone) => {
  const digits = digitsOnly(phone);
  const prefixLen = Math.min(4, Math.max(0, digits.length - 2));
  const hidden = Math.max(0, digits.length - prefixLen - 2);
  return `+${digits.slice(0, prefixLen)}${'•'.repeat(hidden)}${digits.slice(-2)}`;
};

// Find the company's customer by email OR phone (contract §2.1). Email is
// lowercased (the schema stores lowercase). Phone formats in the book vary
// (E.164, 07xx, spaced/dashed), so matching is loose: exact match on the stored
// value, or the last 9 digits agree (KE subscriber-number length) — with the
// stored value allowed to contain separators between digits.
const findByIdentifier = async ({ companyId, email, phone }) => {
  const hasEmail = Boolean(email && String(email).trim());
  const hasPhone = Boolean(phone && String(phone).trim());
  if (!companyId) throw apiError(400, 'VALIDATION_ERROR', 'companyId is required');
  if (hasEmail === hasPhone) {
    throw apiError(400, 'VALIDATION_ERROR', 'Provide exactly one of email or phone');
  }

  const company = await InsuranceCompany.findById(companyId)
    .select('companyName')
    .catch(() => null);
  if (!company) throw apiError(400, 'VALIDATION_ERROR', 'Unknown company');

  let customer = null;
  let identifier;
  let identifierType;

  if (hasEmail) {
    identifierType = 'email';
    identifier = String(email).trim().toLowerCase();
    customer = await Customer.findOne({
      company: company._id,
      email: identifier,
      isDeleted: { $ne: true },
    });
  } else {
    identifierType = 'phone';
    identifier = String(phone).trim();
    const last9 = digitsOnly(identifier).slice(-9);
    const ors = [{ phone: identifier }];
    if (last9.length >= 7) {
      // Last-9-digits suffix match, tolerating separators between stored digits.
      const suffixPattern = `${last9.split('').map(escapeRegex).join('[\\s\\-().]*')}$`;
      ors.push({ phone: { $regex: suffixPattern } });
    }
    customer = await Customer.findOne({
      company: company._id,
      isDeleted: { $ne: true },
      $or: ors,
    });
  }

  return { company, customer, identifier, identifierType };
};

// §2.1 POST /customers/verify-account — "am I in the book?" (+ resend).
const verifyAccount = async ({ companyId, email, phone, ipAddress }) => {
  const { company, customer, identifier, identifierType } = await findByIdentifier({ companyId, email, phone });

  if (!customer) {
    // Every miss is surfaced to the insurer's portal so they see book gaps.
    await CompanyActivity.create({
      company: company._id,
      module: 'Registration',
      action: 'REGISTRATION_MISS',
      description: `Activation attempt with ${identifierType} "${identifier}" did not match any customer in the book`,
      performedBy: identifier,
      ipAddress,
      metadata: { identifierType, identifier },
    }).catch((err) => logger.error('Failed to log REGISTRATION_MISS: %s', err.message));

    throw apiError(
      404,
      'NOT_IN_BOOK',
      `We couldn't find you with ${company.companyName}. Please contact them to update your records.`
    );
  }

  if (customer.status === 'active') {
    throw apiError(409, 'ALREADY_ACTIVE', 'This account is already active. Please log in or reset your password.');
  }

  // Email identifier → OTP to that email. Phone identifier → WhatsApp OTP to
  // the number ON FILE (never a user-typed destination).
  const channel = identifierType === 'email' ? 'email' : 'whatsapp';
  const destination = identifierType === 'email' ? customer.email : customer.phone;
  if (!destination) {
    throw apiError(400, 'VALIDATION_ERROR', 'No usable contact on file for this account. Please contact your insurer.');
  }

  const { resendAfterSeconds } = await otpService.issueCode({ customer, channel, destination });

  if (customer.status === 'imported') {
    // updateOne (not save) — never trips full-document validation on legacy records.
    await Customer.updateOne(
      { _id: customer._id, status: 'imported' },
      { $set: { status: 'invited', invitedAt: new Date() } }
    );
  }

  return {
    channel,
    maskedDestination: channel === 'email' ? maskEmail(destination) : maskPhone(destination),
    resendAfterSeconds,
  };
};

// §2.2 POST /customers/verify-account/confirm — check the OTP, mint the
// single-purpose activation token.
const confirmVerification = async ({ companyId, email, phone, code }) => {
  if (!code || !String(code).trim()) {
    throw apiError(400, 'INVALID_CODE', 'The verification code is incorrect.');
  }
  const { customer } = await findByIdentifier({ companyId, email, phone });
  if (!customer) {
    throw apiError(404, 'NOT_IN_BOOK', "We couldn't find a matching account. Please start verification again.");
  }
  if (customer.status === 'active') {
    throw apiError(409, 'ALREADY_ACTIVE', 'This account is already active. Please log in or reset your password.');
  }

  const otpDoc = await otpService.verifyCode({ customerId: customer._id, code: String(code).trim() });

  const activationToken = tokenService.generateActivationToken(
    customer._id.toString(),
    otpDoc._id.toString(),
    otpDoc.channel
  );
  return { activationToken };
};

const SENSITIVE_FIELDS = ['password', 'mfaSecret', 'resetPasswordToken', 'resetPasswordExpires', 'fcmToken'];

// §2.3 POST /customers/activate — set the password, flip the account active,
// return a normal login session.
const activateAccount = async ({ activationToken, password }) => {
  let decoded;
  try {
    decoded = jwt.verify(activationToken, publicKey.replace(/\\n/gm, '\n'), {
      issuer: TokenIssuer,
      algorithms: ['RS512'],
    });
  } catch {
    throw apiError(401, 'INVALID_ACTIVATION_TOKEN', 'Activation session is invalid or has expired. Please verify again.');
  }
  const payload = decoded.payload || {};
  if (payload.purpose !== 'activation' || !payload.id || !payload.otp) {
    throw apiError(401, 'INVALID_ACTIVATION_TOKEN', 'Activation session is invalid or has expired. Please verify again.');
  }

  assertValidPassword(password);

  // Single use: the token is bound to the consumed OTP document; deleting it is
  // atomic, so of any concurrent (or replayed) activations exactly one wins.
  const otpDoc = await OtpCode.findOneAndDelete({
    _id: payload.otp,
    customerId: payload.id,
    purpose: 'activation',
    consumedAt: { $ne: null },
  });
  if (!otpDoc) {
    throw apiError(401, 'INVALID_ACTIVATION_TOKEN', 'This activation link has already been used or has expired. Please verify again.');
  }

  const customer = await Customer.findById(payload.id).populate('company', 'companyName logo');
  if (!customer || customer.isDeleted) {
    throw apiError(401, 'INVALID_ACTIVATION_TOKEN', 'Activation session is invalid. Please verify again.');
  }
  if (customer.status === 'active') {
    throw apiError(401, 'INVALID_ACTIVATION_TOKEN', 'This account is already active. Please log in.');
  }

  const update = {
    password: await bcrypt.hash(password, 10),
    status: 'active',
    activatedAt: new Date(),
  };
  if (payload.channel === 'email') update.emailVerified = true;
  // updateOne (not save) — legacy imported records must not fail activation on
  // unrelated schema validation.
  await Customer.updateOne({ _id: customer._id }, { $set: update });
  Object.assign(customer, update);

  // Token carries the tenant claim via customer.company (GenerateToken resolves it).
  const tokens = tokenService.GenerateToken(customer);

  const user = customer.toObject();
  SENSITIVE_FIELDS.forEach((f) => delete user[f]);

  return { user, tokens };
};

module.exports = { verifyAccount, confirmVerification, activateAccount, maskEmail, maskPhone };
