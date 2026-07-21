/**
 * /api/v1  — Company-facing API authenticated with API keys.
 *
 * Insurance companies call these endpoints using their API key:
 *   x-api-key: xxxxxxxx.xxxxxxxxxxxxxxxx...
 *
 * All routes attach req.company (populated InsuranceCompany).
 */

const express = require('express');
const router = express.Router();
const verifyApiKey = require('../middlewheres/verifyApiKey');

const InsuranceCompany = require('../models/insuranceCompany.model');
const CompanySubscription = require('../models/companySubscription.model');
const Invoice = require('../models/invoice.model');
const ApiKey = require('../models/apiKey.model');
const customerImportService = require('../service/customerImport.service');

// ── Book import (docs/Mobile-Activation-API.md §4) ────────────────────────────

// Batch import/merge of the insurer's policy book. Row-level validation:
// a failed row never aborts the batch. `dryRun: true` validates and simulates
// without writing.
router.post('/customers/batch', verifyApiKey(['customers:write']), async (req, res) => {
  try {
    const { dryRun = false, customers } = req.body || {};
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ message: '`customers` must be a non-empty array' });
    }
    if (customers.length > customerImportService.MAX_BATCH_SIZE) {
      return res.status(413).json({
        message: `Too many customers: max ${customerImportService.MAX_BATCH_SIZE} per call`,
      });
    }
    const result = await customerImportService.importBatch({
      company: req.company,
      customers,
      dryRun: Boolean(dryRun),
      performedBy: `apikey:${req.apiKey.keyName}`,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rollback: deletes only that batch's customers still at status 'imported'
// with no claims; reports deleted vs retained counts.
router.delete('/customers/batch/:batchId', verifyApiKey(['customers:write']), async (req, res) => {
  try {
    const result = await customerImportService.rollbackBatch({
      company: req.company,
      batchId: req.params.batchId,
      performedBy: `apikey:${req.apiKey.keyName}`,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Company profile ───────────────────────────────────────────────────────────

router.get('/company', verifyApiKey(), async (req, res) => {
  try {
    const company = await InsuranceCompany.findById(req.company._id)
      .select('-password');
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.json(company);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Subscriptions ─────────────────────────────────────────────────────────────

router.get('/subscriptions', verifyApiKey(), async (req, res) => {
  try {
    const subs = await CompanySubscription.find({ company: req.company._id })
      .populate('plan', 'name price billingCycle features')
      .sort({ createdAt: -1 });
    res.json(subs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/subscriptions/active', verifyApiKey(), async (req, res) => {
  try {
    const sub = await CompanySubscription.findOne({
      company: req.company._id,
      status: { $in: ['active', 'trial'] },
    }).populate('plan', 'name price billingCycle features');
    if (!sub) return res.status(404).json({ message: 'No active subscription found' });
    res.json(sub);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Invoices ──────────────────────────────────────────────────────────────────

router.get('/invoices', verifyApiKey(), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { company: req.company._id };
    if (status) filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [invoices, total] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Invoice.countDocuments(filter),
    ]);
    res.json({ invoices, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/invoices/:id', verifyApiKey(), async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, company: req.company._id });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── API key info ──────────────────────────────────────────────────────────────

// Returns metadata about the key being used (useful for clients to check expiry/permissions)
router.get('/me', verifyApiKey(), (req, res) => {
  const { _id, keyName, permissions, status, expiresAt, lastUsedAt, usageCount, createdAt } = req.apiKey;
  res.json({
    keyId: _id,
    keyName,
    permissions,
    status,
    expiresAt,
    lastUsedAt,
    usageCount,
    createdAt,
    company: {
      _id: req.company._id,
      companyName: req.company.companyName,
      email: req.company.email,
      status: req.company.status,
    },
  });
});

module.exports = router;
