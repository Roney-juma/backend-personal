const VendorInvoice = require('../models/vendorInvoice.model');
const Claim = require('../models/claim.model');
const SupplyBid = require('../models/supplyBids.model');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');
const notificationService = require('./notification.service');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');

// A claim may only be invoiced once it has been assessed. These are the statuses
// at or beyond assessment (everything except the pre-assessment states
// Pending / Approved / Rejected / Resubmitted / Assessment).
const ASSESSED_STATUSES = new Set([
  'Assessed', 'Awarded', 'Repair', 'Garage', 'Re-Assessment', 'ReAssessed',
  'SelfRepair', 'UnderRepair', 'Completed', 'UnderInvestigation', 'Investigated',
  'GlassApproved', 'GlassRepair',
]);

const round2 = (n) => parseFloat(Number(n || 0).toFixed(2));

// A single-line invoice for a flat awarded amount.
const oneLine = (description, amount) => {
  const a = round2(amount);
  return { items: [{ description, quantity: 1, unitPrice: a, total: a }], subtotal: a, total: a };
};

// Account types (from the JWT payload) that may raise an invoice, mapped to the
// model that owns them and the field holding their insurance company.
const VENDORS = {
  Assessor: { model: Assessor, companyField: 'company', recipientType: 'assessor' },
  Garage: { model: Garage, companyField: 'company', recipientType: 'garage' },
  Supplier: { model: Supplier, companyField: 'insuranceCompany', recipientType: 'supplier' },
};

const isVendor = (accountType) => Boolean(VENDORS[accountType]);

const idEq = (a, b) => a && b && String(a) === String(b);

// Company an admin/staff requester is scoped to. Insurance-company staff (User /
// ProviderUser tokens) carry their own company; AVE platform staff resolve to null
// (global scope), matching the rest of the app's tenant model.
const resolveAdminCompany = async (req) => {
  if (req.user?.accountType === 'InsuranceCompany') return req.user.id;
  return getRequesterCompany(req);
};

/**
 * Confirm the vendor is genuinely attached to the claim they're billing for.
 * Guards against a vendor invoicing a company for work that isn't theirs.
 */
const vendorIsOnClaim = async (vendorType, vendorId, claim) => {
  switch (vendorType) {
    case 'Assessor':
      return (
        idEq(claim.awardedAssessor?.assessorId, vendorId) ||
        idEq(claim.reAssessmentReport?.assessorId, vendorId)
      );
    case 'Garage':
      return (
        idEq(claim.awardedGarage?.garageId, vendorId) ||
        idEq(claim.garageRepairReport?.garageId, vendorId)
      );
    case 'Supplier':
      // Parts suppliers are attached via their accepted SupplyBid, not claim.bids.
      return (
        idEq(claim.glassRepair?.supplierId, vendorId) ||
        (claim.bids || []).some((b) => idEq(b.awardedSupplierId, vendorId)) ||
        Boolean(
          await SupplyBid.exists({
            claimId: claim._id,
            supplierId: vendorId,
            status: { $in: ['Accepted', 'Delivered'] },
          })
        )
      );
    default:
      return false;
  }
};

/**
 * Build the invoice line items from the vendor's *awarded bid* on this claim, so
 * the amount always reflects what was agreed — never a figure typed by the vendor.
 * Returns { items, subtotal, total }.
 */
const resolveAwardedAmount = async (vendorType, vendorId, claim) => {
  if (vendorType === 'Assessor') {
    return oneLine('Assessment services', claim.awardedAssessor?.awardedAmount);
  }

  if (vendorType === 'Garage') {
    const awarded = claim.awardedGarage?.awardedAmount;
    // Prefer the awarded garage bid's parts breakdown when present.
    const bid = (claim.bids || []).find(
      (b) => b.bidderType === 'garage' && idEq(b.garageId, vendorId) && b.status === 'awarded'
    );
    const parts = bid?.parts || [];
    if (parts.length) {
      const items = parts.map((p) => ({
        description: p.partName || 'Repair item',
        quantity: 1,
        unitPrice: round2(p.cost),
        total: round2(p.cost),
      }));
      const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
      // The awarded amount is the source of truth; if it differs from the parts
      // sum (e.g. negotiated down), bill the awarded amount instead.
      if (awarded != null && Math.abs(awarded - subtotal) > 0.01) {
        return oneLine('Repair work', awarded);
      }
      return { items, subtotal, total: subtotal };
    }
    return oneLine('Repair work', awarded);
  }

  // Supplier — the accepted supply bid holds the parts + total.
  const supplyBid = await SupplyBid.findOne({
    claimId: claim._id,
    supplierId: vendorId,
    status: { $in: ['Accepted', 'Delivered'] },
  });
  const parts = supplyBid?.parts || [];
  const totalCost = supplyBid?.totalCost;
  if (parts.length) {
    const items = parts.map((p) => ({
      description: p.partName || 'Part',
      quantity: 1,
      unitPrice: round2(p.cost),
      total: round2(p.cost),
    }));
    const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
    if (totalCost != null && Math.abs(totalCost - subtotal) > 0.01) {
      return oneLine('Parts supplied', totalCost);
    }
    return { items, subtotal, total: subtotal };
  }
  return oneLine('Parts supplied', totalCost);
};

/**
 * A vendor (assessor/garage/supplier) submits an invoice for a claim they worked on.
 * Rules: the claim must be assessed, only one invoice per claim per vendor, and the
 * amount is taken from the vendor's awarded bid (not the request body).
 */
const createInvoice = async (req) => {
  const actor = req.user;
  const vendorType = actor.accountType;
  if (!isVendor(vendorType)) {
    throw new ApiError(403, 'Only assessors, garages and suppliers can submit invoices');
  }

  const { claim: claimId, notes, attachments } = req.body;
  if (!claimId) throw new ApiError(400, 'A claim reference is required');

  // Resolve the vendor to derive their company (never taken from the request).
  const { model, companyField } = VENDORS[vendorType];
  const vendorDoc = await model.findById(actor.id);
  if (!vendorDoc) throw new ApiError(404, 'Vendor account not found');

  const companyId = vendorDoc[companyField];
  if (!companyId) {
    throw new ApiError(400, 'Your account is not linked to an insurance company');
  }

  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, 'Claim not found');

  if (!(await vendorIsOnClaim(vendorType, actor.id, claim))) {
    throw new ApiError(403, 'You are not assigned to this claim');
  }

  // Rule 1: the claim must have been assessed.
  if (!ASSESSED_STATUSES.has(claim.status)) {
    throw new ApiError(400, 'You can only invoice a claim that has been assessed');
  }

  // Rule 2: one active invoice per claim per vendor (a cancelled one may be re-raised).
  const existing = await VendorInvoice.countDocuments({
    claim: claimId,
    vendor: actor.id,
    status: { $ne: 'cancelled' },
  });
  if (existing > 0) {
    throw new ApiError(409, 'You have already submitted an invoice for this claim');
  }

  // Rule 3: the amount comes from the awarded bid, not the request body.
  const { items, subtotal, total } = await resolveAwardedAmount(vendorType, actor.id, claim);
  if (!(total > 0)) {
    throw new ApiError(400, 'No awarded bid amount was found for this claim');
  }

  const invoice = await VendorInvoice.create({
    vendorType,
    vendor: actor.id,
    company: companyId,
    claim: claimId,
    items,
    subtotal,
    taxRate: 0,
    tax: 0,
    total,
    currency: 'KES',
    notes,
    attachments: Array.isArray(attachments)
      ? attachments.filter((a) => typeof a === 'string').slice(0, 10)
      : [],
  });

  return invoice;
};

/**
 * List invoices scoped to the caller:
 *  - vendor        -> only their own invoices
 *  - company admin -> invoices billed to their company (platform staff: all)
 */
const getInvoices = async (req) => {
  const actor = req.user;
  const { status, claim, page = 1, limit = 20 } = req.query;
  const filter = {};

  if (isVendor(actor.accountType)) {
    filter.vendor = actor.id;
    filter.vendorType = actor.accountType;
  } else {
    const company = await resolveAdminCompany(req);
    if (company) filter.company = company; // platform staff (null) => all companies
  }
  if (status) filter.status = status;
  if (claim) filter.claim = claim;

  const p = Math.max(Number(page) || 1, 1);
  const l = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (p - 1) * l;

  const [invoices, total] = await Promise.all([
    VendorInvoice.find(filter)
      .populate('vendor', 'name email')
      .populate('company', 'companyName email')
      .populate('claim', 'status incidentDetails')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l),
    VendorInvoice.countDocuments(filter),
  ]);

  return { invoices, total, page: p, limit: l, pages: Math.ceil(total / l) };
};

// Fetch one invoice, enforcing the same ownership scope as the list.
const getInvoiceById = async (req, id) => {
  const invoice = await VendorInvoice.findById(id)
    .populate('vendor', 'name email')
    .populate('company', 'companyName email')
    .populate('claim', 'status incidentDetails');
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  await assertCanAccess(req, invoice);
  return invoice;
};

// A vendor may see their own invoice; an admin may see any invoice for their company
// (platform staff: any).
const assertCanAccess = async (req, invoice) => {
  const actor = req.user;
  if (isVendor(actor.accountType)) {
    if (!idEq(invoice.vendor?._id || invoice.vendor, actor.id)) {
      throw new ApiError(403, 'Not authorized for this invoice');
    }
    return;
  }
  const company = await resolveAdminCompany(req);
  if (!belongsToCompany(invoice.company?._id || invoice.company, company)) {
    throw new ApiError(403, 'Not authorized for this invoice');
  }
};

/**
 * Insurance-company admin marks an invoice paid.
 */
const markAsPaid = async (req, id, { paymentMethod, paymentReference } = {}) => {
  const actor = req.user;
  if (isVendor(actor.accountType)) {
    throw new ApiError(403, 'Only company admins can pay invoices');
  }
  const invoice = await VendorInvoice.findById(id);
  if (!invoice) throw new ApiError(404, 'Invoice not found');

  const company = await resolveAdminCompany(req);
  if (!belongsToCompany(invoice.company, company)) {
    throw new ApiError(403, 'This invoice was not billed to your company');
  }
  if (invoice.status === 'paid') throw new ApiError(409, 'Invoice is already paid');
  if (invoice.status === 'cancelled') throw new ApiError(409, 'Cannot pay a cancelled invoice');

  invoice.status = 'paid';
  invoice.paidAt = new Date();
  invoice.paidBy = actor.id;
  if (paymentMethod) invoice.paymentMethod = paymentMethod;
  if (paymentReference) invoice.paymentReference = paymentReference;
  await invoice.save();

  // Notify the vendor they've been paid (socket room + FCM via recipientType).
  const { recipientType } = VENDORS[invoice.vendorType];
  notificationService
    .createAndEmit({
      recipientId: invoice.vendor,
      recipientType,
      type: 'invoice_paid',
      title: 'Invoice paid',
      content: `Invoice ${invoice.invoiceNumber} for ${invoice.currency} ${invoice.total.toFixed(2)} has been paid.`,
      claimId: invoice.claim,
    })
    .catch((err) => logger.warn('invoice_paid notification failed: %s', err.message));

  return invoice;
};

/**
 * A vendor withdraws their own invoice before it is paid.
 */
const cancelInvoice = async (req, id, { reason } = {}) => {
  const invoice = await VendorInvoice.findById(id);
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  await assertCanAccess(req, invoice);
  if (invoice.status === 'paid') throw new ApiError(409, 'A paid invoice cannot be cancelled');
  if (invoice.status === 'cancelled') throw new ApiError(409, 'Invoice is already cancelled');

  invoice.status = 'cancelled';
  invoice.cancelledAt = new Date();
  if (reason) invoice.cancellationReason = reason;
  await invoice.save();
  return invoice;
};

module.exports = {
  createInvoice,
  getInvoices,
  getInvoiceById,
  markAsPaid,
  cancelInvoice,
};
