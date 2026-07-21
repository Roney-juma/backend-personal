/**
 * Book import (insurer integrations) — contract §4 in docs/Mobile-Activation-API.md.
 *
 * POST /api/v1/customers/batch      → importBatch()
 * DELETE /api/v1/customers/batch/:batchId → rollbackBatch()
 *
 * The API key's company is the tenant: every lookup and write here is scoped to
 * `company`. Row-level validation — a failed row never aborts the batch.
 *
 * Never overwritten by import: `status`, `password` (ever); `email`/`phone` on
 * records that are already `active` (login identity). Attempts are reported per
 * row as `skippedFields`.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const Customer = require('../models/customerModel');
const Claim = require('../models/claim.model');
const CompanyActivity = require('../models/companyActivity.model');

const MAX_BATCH_SIZE = 500;
const POLICY_STATUSES = ['active', 'lapsed', 'cancelled', 'expired'];

// ── helpers ───────────────────────────────────────────────────────────────────

// imp_<yyyymmdd>_<6 random hex>
const newBatchId = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `imp_${y}${m}${d}_${crypto.randomBytes(3).toString('hex')}`;
};

// E.164 normalization with +254 as the default country (07XX…, 7XX… forms).
const normalizePhone = (raw) => {
  const stripped = String(raw).trim().replace(/[\s\-().]/g, '');
  let candidate;
  if (stripped.startsWith('+')) candidate = stripped;
  else if (/^0\d+$/.test(stripped)) candidate = `+254${stripped.slice(1)}`; // 07XX / 01XX
  else if (/^[17]\d+$/.test(stripped)) candidate = `+254${stripped}`; // 7XX / 1XX
  else if (/^254\d+$/.test(stripped)) candidate = `+${stripped}`;
  else candidate = `+${stripped}`;
  if (!/^\+[1-9]\d{8,14}$/.test(candidate)) return { error: true };
  return { value: candidate };
};

// Accepts ISO-8601 or YYYY-MM-DD (both parse natively).
const parseDate = (raw) => {
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return { error: true };
  return { value: d };
};

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Primary-policy mirror: first *active* policy, else the first policy.
const primaryPolicy = (policies) =>
  policies.find((p) => (p.status || 'active') === 'active') || policies[0];

/**
 * Validates + normalizes one input row. Returns { errors, row, skippedFields }.
 * `row` only contains fields that were actually supplied (so updates never
 * $set fields the insurer didn't send).
 */
const normalizeRow = (raw) => {
  const errors = [];
  const skippedFields = [];
  const row = {};

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['row must be an object'], row: null, skippedFields };
  }

  // Import may never set lifecycle status or credentials.
  if (raw.status !== undefined) skippedFields.push('status');
  if (raw.password !== undefined) skippedFields.push('password');

  for (const f of ['firstName', 'lastName', 'idNumber']) {
    if (has(raw[f])) row[f] = String(raw[f]).trim();
  }

  if (has(raw.email)) {
    const email = String(raw.email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('email is not a valid email address');
    else row.email = email;
  }

  if (has(raw.phone)) {
    const { value, error } = normalizePhone(raw.phone);
    if (error) errors.push('phone could not be normalized to E.164');
    else row.phone = value;
  }

  if (!Array.isArray(raw.policies) || raw.policies.length === 0) {
    errors.push('policies must contain at least one policy');
  } else {
    row.policies = [];
    raw.policies.forEach((p, pi) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`policies[${pi}] must be an object`);
        return;
      }
      if (!has(p.policyNumber)) {
        errors.push(`policies[${pi}].policyNumber is required`);
        return;
      }
      const pol = { policyNumber: String(p.policyNumber).trim() };
      if (has(p.policyType)) pol.policyType = String(p.policyType).trim();
      if (p.status !== undefined) {
        if (!POLICY_STATUSES.includes(p.status)) {
          errors.push(`policies[${pi}].status must be one of: ${POLICY_STATUSES.join(', ')}`);
        } else {
          pol.status = p.status;
        }
      }
      for (const df of ['startDate', 'expiryDate']) {
        if (has(p[df])) {
          const { value, error } = parseDate(p[df]);
          if (error) errors.push(`policies[${pi}].${df} is not a valid date (use ISO 8601 or YYYY-MM-DD)`);
          else pol[df] = value;
        }
      }
      if (p.vehicle && typeof p.vehicle === 'object' && !Array.isArray(p.vehicle)) {
        const v = {};
        for (const vf of ['registration', 'make', 'model', 'chassisNumber']) {
          if (has(p.vehicle[vf])) v[vf] = String(p.vehicle[vf]).trim();
        }
        if (has(p.vehicle.year)) {
          const year = Number(p.vehicle.year);
          if (Number.isNaN(year)) errors.push(`policies[${pi}].vehicle.year must be a number`);
          else v.year = year;
        }
        if (Object.keys(v).length) pol.vehicle = v;
      }
      row.policies.push(pol);
    });
  }

  return { errors, row, skippedFields };
};

/**
 * One indexed lookup per row, scoped to the company. Precedence is applied to
 * the candidates in memory: idNumber → email → phone → any policy number.
 */
const findMatch = async (companyId, row) => {
  const or = [];
  if (row.idNumber) or.push({ idNumber: row.idNumber });
  if (row.email) or.push({ email: row.email });
  if (row.phone) or.push({ phone: row.phone });
  const policyNumbers = row.policies.map((p) => p.policyNumber);
  or.push({ 'policies.policyNumber': { $in: policyNumbers } });
  or.push({ policyNumber: { $in: policyNumbers } }); // legacy records without policies[]

  const candidates = await Customer.find({ company: companyId, $or: or })
    .select('-password')
    .limit(10);
  if (candidates.length === 0) return null;
  if (row.idNumber) {
    const m = candidates.find((c) => c.idNumber === row.idNumber);
    if (m) return m;
  }
  if (row.email) {
    const m = candidates.find((c) => c.email === row.email);
    if (m) return m;
  }
  if (row.phone) {
    const m = candidates.find((c) => c.phone === row.phone);
    if (m) return m;
  }
  const nums = new Set(policyNumbers);
  return (
    candidates.find(
      (c) => nums.has(c.policyNumber) || (c.policies || []).some((p) => nums.has(p.policyNumber))
    ) || null
  );
};

// Upsert incoming policies into the existing array by policyNumber.
const mergePolicies = (existingPolicies, incomingPolicies) => {
  const merged = (existingPolicies || []).map((p) => (p.toObject ? p.toObject() : { ...p }));
  for (const inc of incomingPolicies) {
    const idx = merged.findIndex((p) => p.policyNumber === inc.policyNumber);
    if (idx === -1) {
      merged.push(inc);
    } else {
      const target = merged[idx];
      if (inc.policyType !== undefined) target.policyType = inc.policyType;
      if (inc.status !== undefined) target.status = inc.status;
      if (inc.startDate !== undefined) target.startDate = inc.startDate;
      if (inc.expiryDate !== undefined) target.expiryDate = inc.expiryDate;
      if (inc.vehicle !== undefined) target.vehicle = { ...(target.vehicle || {}), ...inc.vehicle };
    }
  }
  return merged;
};

// Builds the $set for a matched customer. Never touches status/password;
// email/phone are frozen once the account is `active` (login identity).
const buildUpdateSet = (existing, row) => {
  const set = {};
  const skipped = [];
  if (row.firstName !== undefined) set.firstName = row.firstName;
  if (row.lastName !== undefined) set.lastName = row.lastName;
  if (row.idNumber !== undefined && row.idNumber !== existing.idNumber) set.idNumber = row.idNumber;

  const frozen = existing.status === 'active';
  if (row.email !== undefined && row.email !== existing.email) {
    if (frozen) skipped.push('email');
    else set.email = row.email;
  }
  if (row.phone !== undefined && row.phone !== existing.phone) {
    if (frozen) skipped.push('phone');
    else set.phone = row.phone;
  }

  const mergedPolicies = mergePolicies(existing.policies, row.policies);
  set.policies = mergedPolicies;
  const primary = primaryPolicy(mergedPolicies);
  set.policyNumber = primary.policyNumber;
  if (primary.policyType) set.policyType = primary.policyType;

  return { set, skipped };
};

const logActivity = (company, action, description, performedBy, ipAddress, metadata) =>
  CompanyActivity.create({
    company: company._id,
    module: 'BookImport',
    action,
    description,
    performedBy,
    ipAddress,
    metadata,
  });

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Imports (or dry-runs) a batch of customers for `company`.
 * Returns { batchId, summary: { received, created, updated, failed }, results }.
 */
const importBatch = async ({ company, customers, dryRun = false, performedBy, ipAddress }) => {
  const batchId = newBatchId();
  const results = [];
  const ops = [];
  const opEntries = []; // parallel to ops: result entry per write op

  for (let i = 0; i < customers.length; i++) {
    const { errors, row, skippedFields } = normalizeRow(customers[i]);
    if (errors.length) {
      results.push({ index: i, action: 'failed', errors });
      continue;
    }

    const existing = await findMatch(company._id, row);
    if (existing) {
      const { set, skipped } = buildUpdateSet(existing, row);
      const entry = { index: i, action: 'updated', customerId: String(existing._id) };
      const allSkipped = [...skippedFields, ...skipped];
      if (allSkipped.length) entry.skippedFields = allSkipped;
      results.push(entry);
      if (!dryRun) {
        opEntries.push(entry);
        ops.push({ updateOne: { filter: { _id: existing._id }, update: { $set: set } } });
      }
    } else {
      const _id = new mongoose.Types.ObjectId();
      const primary = primaryPolicy(row.policies);
      const doc = {
        _id,
        ...row,
        policyNumber: primary.policyNumber,
        // Top-level policyType is required by the schema; the mirror falls back
        // when the primary policy came without one.
        policyType: primary.policyType || 'Unspecified',
        Insurer: company.companyName,
        company: company._id,
        status: 'imported',
        source: 'import',
        importBatchId: batchId,
        emailVerified: false,
      };
      const entry = { index: i, action: 'created', customerId: String(_id) };
      if (skippedFields.length) entry.skippedFields = skippedFields;
      results.push(entry);
      if (!dryRun) {
        opEntries.push(entry);
        ops.push({ insertOne: { document: doc } });
      }
    }
  }

  if (!dryRun && ops.length) {
    try {
      await Customer.bulkWrite(ops, { ordered: false });
    } catch (err) {
      // Unordered bulkWrite: surviving ops were applied; map each write error
      // back to its row instead of failing the whole batch.
      const writeErrors = err.writeErrors || [];
      if (!writeErrors.length) throw err;
      for (const we of writeErrors) {
        const opIdx = typeof we.index === 'number' ? we.index : we.err && we.err.index;
        const entry = opEntries[opIdx];
        if (!entry) continue;
        const code = we.code !== undefined ? we.code : we.err && we.err.code;
        entry.action = 'failed';
        delete entry.customerId;
        delete entry.skippedFields;
        entry.errors = [
          code === 11000
            ? 'duplicate key: policyNumber or email already belongs to another customer of this company'
            : we.errmsg || (we.err && we.err.errmsg) || 'write failed',
        ];
      }
    }
  }

  const summary = {
    received: customers.length,
    created: results.filter((r) => r.action === 'created').length,
    updated: results.filter((r) => r.action === 'updated').length,
    failed: results.filter((r) => r.action === 'failed').length,
  };

  await logActivity(
    company,
    dryRun ? 'BOOK_IMPORT_DRY_RUN' : 'BOOK_IMPORT',
    `Book import batch ${batchId}${dryRun ? ' (dry run)' : ''}: ` +
      `${summary.created} created, ${summary.updated} updated, ${summary.failed} failed of ${summary.received}`,
    performedBy,
    ipAddress,
    { batchId, dryRun, summary }
  );

  return { batchId, summary, results };
};

/**
 * Rolls back an import batch: deletes only that batch's customers still at
 * status 'imported' with no claims. Returns { batchId, deleted, retained }.
 */
const rollbackBatch = async ({ company, batchId, performedBy, ipAddress }) => {
  const members = await Customer.find({ company: company._id, importBatchId: batchId })
    .select('_id status')
    .lean();

  const importedIds = members.filter((m) => m.status === 'imported').map((m) => m._id);
  const statusChanged = members.length - importedIds.length;

  let withClaims = new Set();
  if (importedIds.length) {
    const claimants = await Claim.distinct('customerId', { customerId: { $in: importedIds } });
    withClaims = new Set(claimants.map(String));
  }
  const deletableIds = importedIds.filter((id) => !withClaims.has(String(id)));

  let deleted = 0;
  if (deletableIds.length) {
    const res = await Customer.deleteMany({
      _id: { $in: deletableIds },
      company: company._id,
      importBatchId: batchId,
      status: 'imported', // re-checked at delete time in case of concurrent activation
    });
    deleted = res.deletedCount || 0;
  }

  const result = {
    batchId,
    deleted,
    retained: {
      count: members.length - deleted,
      reasons: {
        statusChanged, // invited/activated since import — never deleted
        hasClaims: withClaims.size,
      },
    },
  };

  await logActivity(
    company,
    'BOOK_IMPORT_ROLLBACK',
    `Rollback of import batch ${batchId}: ${result.deleted} deleted, ${result.retained.count} retained`,
    performedBy,
    ipAddress,
    result
  );

  return result;
};

module.exports = { importBatch, rollbackBatch, MAX_BATCH_SIZE };
