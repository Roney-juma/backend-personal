const Customer = require("../models/customerModel.js");
const InsuranceCompany = require('../models/insuranceCompany.model');
const Garage = require('../models/garage.model');
const Assessor = require('../models/assessor.model.js');
const Claim = require('../models/claim.model');
const bcrypt = require('bcrypt')
const ApiError = require('../utils/ApiError.js');
const emailService = require("../service/email.service");
const tokenService = require("../service/token.service");
const { createResetToken, verifyResetToken, resetEmailBody } = require("../utils/passwordReset");
const { isLocked, registerFailedAttempt, resetAttempts, AccountLockedError } = require("../utils/accountLockout");
const { assertValidPassword } = require("../utils/passwordPolicy");
const { belongsToCompany } = require("../utils/requesterCompany");

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Resolve the tenant for a new customer. A portal admin's own company always wins
// over anything client-supplied. Otherwise a body `company` id is honoured when it
// points at an existing, non-suspended InsuranceCompany, then the free-text
// `Insurer` name is matched case-insensitively against companyName. Registration
// never fails on an unresolvable tenant — `company` is simply left unset.
const resolveCustomerCompany = async (cus, requesterCompany) => {
  if (requesterCompany) return requesterCompany;

  if (cus.company) {
    const byId = await InsuranceCompany.findOne({ _id: cus.company, status: { $ne: 'suspended' } })
      .select('_id')
      .catch(() => null); // invalid ObjectId — ignore rather than fail
    if (byId) return byId._id;
  }

  if (cus.Insurer && cus.Insurer.trim()) {
    const byName = await InsuranceCompany.findOne({
      companyName: new RegExp(`^${escapeRegex(cus.Insurer.trim())}$`, 'i'),
    }).select('_id');
    if (byName) return byName._id;
  }

  return undefined;
};

async function createCustomer(cus, requesterCompany) {
  // Schema-level email is optional (phone-only imported book records), so
  // self/admin registration enforces it here.
  if (!cus.email || !String(cus.email).trim()) {
    throw new Error('Email is required');
  }
  // Cross-actor check stays global: an email that logs in as a garage or
  // assessor can never also be a customer login.
  const existingGarage = await Garage.findOne({ email: cus.email });
  const existingAssessor = await Assessor.findOne({ email: cus.email });
  if (existingGarage || existingAssessor) {
    throw new Error('We already have this Email in the System');
  }

  assertValidPassword(cus.password);
  const password = await bcrypt.hash(cus.password, 10);
  cus.password = password;

  // Overwrites any client-supplied value that failed validation above.
  cus.company = await resolveCustomerCompany(cus, requesterCompany);

  // Customer uniqueness is per insurer (multi-insurer contract: the same email
  // may hold one account with each insurer — login shows a company picker).
  // `?? null` so records with no resolved tenant still collide with each other.
  const existingCustomer = await Customer.findOne({
    email: cus.email,
    company: cus.company ?? null,
  });
  if (existingCustomer) {
    throw new Error('Customer already exists');
  }

  // Mirror the primary policy into the policies array (the book-import shape),
  // so self-registered customers look the same as imported ones downstream.
  if (!Array.isArray(cus.policies) || !cus.policies.length) {
    cus.policies = [{ policyNumber: cus.policyNumber, policyType: cus.policyType }];
  }

  // Create new customer
  return await Customer.create(cus);
}

// Normalise + validate one row of an import payload into a persistable customer
// doc scoped to `company`. Returns { doc } on success or { error } on a bad row.
// Imported records carry no credential (status 'imported'); they activate later.
const buildImportedCustomer = (row, company, insurerName, batchId) => {
  const firstName = (row.firstName || '').trim();
  const lastName = (row.lastName || '').trim();
  const email = row.email ? String(row.email).trim().toLowerCase() : undefined;
  const phone = row.phone ? String(row.phone).trim() : undefined;

  if (!firstName || !lastName) return { error: 'firstName and lastName are required' };
  if (!email && !phone) return { error: 'An email or phone is required' };

  const policies = Array.isArray(row.policies) ? row.policies : [];
  if (!policies.length) return { error: 'At least one policy is required' };

  const primary = policies[0];
  if (!primary.policyNumber || !String(primary.policyNumber).trim()) {
    return { error: 'The first policy needs a policyNumber' };
  }
  if (!primary.policyType || !String(primary.policyType).trim()) {
    return { error: 'The first policy needs a policyType' };
  }

  const doc = {
    firstName,
    lastName,
    email,
    phone,
    idNumber: row.idNumber ? String(row.idNumber).trim() : undefined,
    policyNumber: String(primary.policyNumber).trim(),
    policyType: String(primary.policyType).trim(),
    policies,
    Insurer: insurerName,
    company,
    status: 'imported',
    source: 'import',
    importBatchId: batchId,
  };
  return { doc };
};

/**
 * Bulk-import (or single-add) customers into the requester's insurance company.
 * Payload: { customers: [...], dryRun?: boolean }. With dryRun the payload is only
 * validated (nothing is persisted) so the portal can preview the outcome.
 * Every customer is scoped to `company` — never to a tenant supplied in the body.
 */
async function importCustomers(payload, company) {
  if (!company) {
    throw new ApiError(403, 'Only insurance company admins can import customers');
  }
  const rows = Array.isArray(payload?.customers) ? payload.customers : [];
  const dryRun = payload?.dryRun === true;
  if (!rows.length) throw new ApiError(400, 'No customers provided');
  if (rows.length > 5000) throw new ApiError(400, 'Import is limited to 5000 customers per request');

  const companyDoc = await InsuranceCompany.findById(company).select('companyName');
  if (!companyDoc) throw new ApiError(404, 'Insurance company not found');
  const insurerName = companyDoc.companyName;
  const batchId = `import-${Date.now()}`;

  const results = [];
  let created = 0; // for dryRun: rows that WOULD be created
  let invalid = 0;
  let duplicates = 0;

  // Track policy/email seen within THIS payload so intra-file dupes are caught too.
  const seenPolicies = new Set();
  const seenEmails = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const label = `${(row.firstName || '').trim()} ${(row.lastName || '').trim()}`.trim() || `Row ${i + 1}`;

    const { doc, error } = buildImportedCustomer(row, company, insurerName, batchId);
    if (error) {
      invalid++;
      results.push({ index: i, label, status: 'error', message: error });
      continue;
    }

    // Duplicate within the payload.
    const polKey = doc.policyNumber.toLowerCase();
    const emailKey = doc.email;
    if (seenPolicies.has(polKey) || (emailKey && seenEmails.has(emailKey))) {
      duplicates++;
      results.push({ index: i, label, status: 'duplicate', message: 'Duplicate within this file' });
      continue;
    }

    // Duplicate against existing records for this tenant.
    const or = [{ policyNumber: doc.policyNumber }];
    if (doc.email) or.push({ email: doc.email });
    const existing = await Customer.findOne({ company, $or: or }).select('_id');
    if (existing) {
      duplicates++;
      results.push({ index: i, label, status: 'duplicate', message: 'A customer with this policy or email already exists' });
      continue;
    }

    seenPolicies.add(polKey);
    if (emailKey) seenEmails.add(emailKey);

    if (!dryRun) {
      try {
        await Customer.create(doc);
      } catch (e) {
        invalid++;
        results.push({ index: i, label, status: 'error', message: e.message });
        continue;
      }
    }
    created++;
    results.push({ index: i, label, status: dryRun ? 'valid' : 'created' });
  }

  return {
    dryRun,
    total: rows.length,
    created: dryRun ? 0 : created,
    wouldCreate: dryRun ? created : undefined,
    invalid,
    duplicates,
    results,
  };
}
// Multi-insurer aware login (contract §3). The same email can now exist once
// per insurer, so all non-deleted records are candidates; an optional companyId
// (sent by the app after the company picker) narrows to one. Only `active`
// records can match — imported/invited ones have no credential and
// isPasswordMatch is false for them anyway. The company list is only revealed
// AFTER password verification.
const loginUser = async (email, password, companyId) => {
  const query = {
    email: String(email || '').trim().toLowerCase(),
    isDeleted: { $ne: true },
  };
  if (companyId) query.company = companyId;

  const candidates = await Customer.find(query).populate('company', 'companyName logo status');
  if (!candidates.length) {
    throw new Error("Invalid email or password");
  }

  // Preserve the exact single-record behaviour: a locked account rejects
  // before any password check.
  if (candidates.length === 1 && isLocked(candidates[0])) {
    throw new AccountLockedError(candidates[0]);
  }

  // Lockout stays per record: locked candidates are never password-checked
  // (their counters don't move), unlocked ones each keep their own counters.
  // Tenant lifecycle: records under a suspended/inactive insurer can't log in
  // (legacy records with no company are unaffected).
  const activeCandidates = candidates.filter(
    (c) => c.status === 'active' && (!c.company || c.company.status === 'active')
  );
  const lockedBefore = activeCandidates.filter((c) => isLocked(c));
  const checkable = activeCandidates.filter((c) => !isLocked(c));
  const matches = [];
  for (const candidate of checkable) {
    if (await candidate.isPasswordMatch(password)) matches.push(candidate);
  }

  if (matches.length === 1) {
    const user = matches[0];
    await resetAttempts(user);
    const tokens = tokenService.GenerateToken(user);
    return { user, tokens };
  }

  if (matches.length > 1) {
    // Same password at several insurers — app shows a picker, then repeats
    // login with companyId. No tokens are issued yet.
    return {
      selectCompany: true,
      companies: matches.map((c) => ({
        companyId: c.company?._id || c.company || null,
        companyName: c.company?.companyName,
        logo: c.company?.logo,
      })),
    };
  }

  // Zero matches: every checked (active, unlocked) record takes a failed attempt.
  for (const candidate of checkable) {
    await registerFailedAttempt(candidate);
  }
  // As before: a lock is only reported when the account was already locked
  // coming into this request (an attempt that just triggered the lock still
  // reads as invalid credentials, matching the previous single-record flow).
  if (activeCandidates.length && lockedBefore.length === activeCandidates.length) {
    throw new AccountLockedError(lockedBefore[0]);
  }
  throw new Error("Invalid email or password");
};

const getCustomers = async (company) => {
  const query = {};
  if (company) query.company = company;
  return await Customer.find(query).lean();
};

const withCode = (statusCode, code, message) => {
  const err = new ApiError(statusCode, message);
  err.code = code;
  return err;
};

// Sibling records = same person (email or phone match) at other insurers.
const siblingIdentityOr = (me) => {
  const or = [];
  if (me.email) or.push({ email: me.email });
  if (me.phone) or.push({ phone: me.phone });
  return or;
};

const CUSTOMER_SENSITIVE_FIELDS = ['password', 'mfaSecret', 'resetPasswordToken', 'resetPasswordExpires', 'fcmToken'];

/**
 * Insurer selector data: every insurer where this person holds a record
 * (matched by email/phone, one entry per insurer). Non-active records are
 * included so the app can grey them out and route into activation; records
 * under suspended insurers are omitted (they can't be logged into at all).
 */
const getMyCompanies = async (userId) => {
  const me = await Customer.findById(userId);
  if (!me || me.isDeleted) throw withCode(404, 'NOT_FOUND', 'Customer not found');

  const or = siblingIdentityOr(me);
  const siblings = or.length
    ? await Customer.find({ $or: or, isDeleted: { $ne: true }, company: { $ne: null } })
        .select('company status')
        .populate('company', 'companyName logo status')
        .lean()
    : [];

  const byCompany = new Map();
  for (const record of siblings) {
    if (!record.company || record.company.status !== 'active') continue;
    const key = String(record.company._id);
    // One record per insurer by email; phone matches can duplicate — prefer
    // the record that is furthest along (active > invited > imported).
    const rank = { active: 2, invited: 1, imported: 0 };
    const prev = byCompany.get(key);
    if (prev && rank[prev.status] >= rank[record.status]) continue;
    byCompany.set(key, {
      companyId: record.company._id,
      companyName: record.company.companyName,
      logo: record.company.logo,
      status: record.status,
      current: String(record._id) === String(me._id),
    });
  }
  return Array.from(byCompany.values());
};

/**
 * Swaps the session to this person's record at another insurer: verifies an
 * ACTIVE sibling record under `companyId` and issues fresh tokens for it.
 * No password re-entry — the caller is already authenticated and sibling
 * hashes are kept in sync by activation/reset.
 */
const switchCompany = async (userId, companyId) => {
  if (!companyId) throw withCode(400, 'VALIDATION_ERROR', 'companyId is required');
  const me = await Customer.findById(userId);
  if (!me || me.isDeleted) throw withCode(404, 'NOT_FOUND', 'Customer not found');

  const or = siblingIdentityOr(me);
  if (!or.length) throw withCode(404, 'NOT_IN_BOOK', 'No account found with this insurer');

  const target = await Customer.findOne({
    company: companyId,
    isDeleted: { $ne: true },
    $or: or,
  }).populate('company', 'companyName logo status');

  if (!target) throw withCode(404, 'NOT_IN_BOOK', 'No account found with this insurer');
  if (target.company && target.company.status !== 'active') {
    throw withCode(403, 'INSURER_UNAVAILABLE', 'This insurer is currently unavailable');
  }
  if (target.status !== 'active') {
    // The app routes this into the activation flow for that insurer.
    throw withCode(409, 'NOT_ACTIVATED', 'This account has not been activated with this insurer yet. Please verify it first.');
  }

  const tokens = tokenService.GenerateToken(target);
  const user = target.toObject();
  CUSTOMER_SENSITIVE_FIELDS.forEach((f) => delete user[f]);
  return { user, tokens };
};

const getCustomerClaims = async (customerId, company) => {
  const customer = await Customer.findById(customerId);
  // Cross-tenant ids read as missing ones (company falsy → no requester scope).
  if (!customer || !belongsToCompany(customer.company, company)) {
    throw new Error('Customer not found');
  }

  // Claims are matched by claimant email, which can exist at several insurers
  // (multi-insurer contract). Tenant scope is the requester's company (portal)
  // or the record's own company (mobile token — portalCompany resolves to null
  // for customers, and without this the app would show every insurer's claims).
  // Pre-tenancy claims have no company stamp, so those match by record id.
  const scope = company || customer.company;
  const query = scope
    ? { 'claimant.email': customer.email, $or: [{ company: scope }, { company: null, customerId: customer._id }] }
    : { 'claimant.email': customer.email };
  const claims = await Claim.find(query).lean();
  if (claims.length === 0) {
    throw new Error('No claims found for this customer');
  }

  return claims;
};
const sendWelcomeEmail = async (customer) => {
  const subject = 'Welcome to Ave Insurance - Your New Account Details';
  const message = `
    Dear ${customer.firstName} ${customer.lastName},

    We are delighted to welcome you to Ave Insurance! Your new account has been successfully created.

    Here are your account details:
    - Name: ${customer.firstName} ${customer.lastName}
    - Email: ${customer.email}
    - Phone: ${customer.phone}

    You can log in to your account using your registered email address. Please feel free to reach out to our support team if you have any questions or need further assistance.

    Thank you for choosing Ave Insurance.

    Best Regards,
    Admin Team
  `;

  await emailService.sendEmailNotification(customer.email, subject, message);
};

const forgotPassword = async (email) => {
  const user = await Customer.findOne({ email });
  if (!user) {
    throw new ApiError(404, 'No account found with that email address');
  }

  const { rawToken, hashedToken, expires } = await createResetToken();
  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = expires;
  await user.save();

  await emailService.sendEmailNotification(
    user.email,
    'Your Ave Insurance password reset code',
    resetEmailBody(user.firstName, rawToken)
  );
  return { message: 'A password reset code has been sent to your email.' };
};

const resetPassword = async (email, token, newPassword) => {
  const user = await Customer.findOne({ email });
  if (!user || !(await verifyResetToken(token, user))) {
    throw new Error('Reset token is invalid or has expired');
  }

  assertValidPassword(newPassword);
  user.password = await bcrypt.hash(newPassword, 10);

  // Invalidate the token so it can only be used once.
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  await user.save();

  // One credential per person across insurers: sync the new hash to every
  // sibling record with this email so the multi-insurer login picker keeps
  // matching all of them.
  await Customer.updateMany(
    { email: user.email, _id: { $ne: user._id }, isDeleted: { $ne: true } },
    { $set: { password: user.password } }
  );

  return { message: 'Password has been reset successfully' };
};

// update customer
const updateCustomer = async (customerId, customer, company) => {
  // Scope to the requester's company (staff → no scope) so cross-tenant updates
  // miss. Strip company from the payload so a company user can't reassign a
  // customer to another tenant.
  const filter = { _id: customerId, ...(company ? { company } : {}) };
  if (company) delete customer.company;
  return await Customer.findOneAndUpdate(filter, customer, { new: true });
};

const getCustomerStats = async (company) => {
  const scope = company ? { company } : {};
  const customersCount = await Customer.countDocuments(scope);
  const newCustomersCount = await Customer.countDocuments({
    ...scope,
    createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
  });
  const recurringCustomersCount = customersCount - newCustomersCount;
  return { customersCount, newCustomersCount, recurringCustomersCount };
  };

// Find garages closer to my claim location
const findGarages = async (claimId) => {
  const claim = await Claim.findById(claimId);
  if (!claim) {
    throw new Error('Invalid request: Claim not found');
  }

  // Extract incident location
  const { longitude: incidentLongitude, latitude: incidentLatitude } = claim.incidentDetails;

  // Find all garages
  const garages = await Garage.find({});

  // Filter garages within a 20 km radius
  const nearbyGarages = garages.filter((garage) => {
    const distance = getDistanceFromLatLonInKm(
      incidentLatitude,
      incidentLongitude,
      garage.location.latitude,
      garage.location.longitude
    );
    return distance <= 30;
  });

  return nearbyGarages;
};

// Helper function to calculate distance between two points using the Haversine formula
const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
      Math.cos(degToRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in kilometers

  return distance;
};

// Helper function to convert degrees to radians
const degToRad = (deg) => (deg * Math.PI) / 180;

const requestAccountDeletion = async ({ email, phone }) => {
  const customer = await Customer.findOne({ email, phone });
  if (!customer) throw new Error('No account found matching the provided email and phone number');
  if (customer.isDeleted) throw new Error('Account is already deleted');
  if (customer.deletionRequestedAt) throw new Error('A deletion request is already pending');

  customer.deletionRequestedAt = new Date();
  await customer.save();

  await emailService.sendEmailNotification(
    customer.email,
    'Account Deletion Request Received',
    `Dear ${customer.firstName || customer.username},\n\nWe have received your request to delete your account. Our team will review it and process the deletion within 7 business days.\n\nIf you did not make this request, please contact support immediately.\n\nBest Regards,\nAVE Insurance Team`
  );

  return { message: 'Account deletion request submitted successfully' };
};

module.exports = {
  createCustomer,
  importCustomers,
  loginUser,
  getCustomers,
  getMyCompanies,
  switchCompany,
  getCustomerClaims,
  sendWelcomeEmail,
  forgotPassword,
  resetPassword,
  updateCustomer,
  getCustomerStats,
  findGarages,
  requestAccountDeletion,
};

