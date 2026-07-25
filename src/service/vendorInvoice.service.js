const VendorInvoice = require('../models/vendorInvoice.model');
const Claim = require('../models/claim.model');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');
const notificationService = require('./notification.service');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');

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
const vendorIsOnClaim = (vendorType, vendorId, claim) => {
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
      return (
        idEq(claim.glassRepair?.supplierId, vendorId) ||
        (claim.bids || []).some((b) => idEq(b.awardedSupplierId, vendorId))
      );
    default:
      return false;
  }
};

const computeTotals = (items, taxRate = 0) => {
  const itemsWithTotal = items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    total: parseFloat((item.quantity * item.unitPrice).toFixed(2)),
  }));
  const subtotal = parseFloat(
    itemsWithTotal.reduce((sum, i) => sum + i.total, 0).toFixed(2)
  );
  const tax = parseFloat(((subtotal * taxRate) / 100).toFixed(2));
  const total = parseFloat((subtotal + tax).toFixed(2));
  return { itemsWithTotal, subtotal, tax, total };
};

/**
 * A vendor (assessor/garage/supplier) submits an invoice for a claim they worked on.
 */
const createInvoice = async (req) => {
  const actor = req.user;
  const vendorType = actor.accountType;
  if (!isVendor(vendorType)) {
    throw new ApiError(403, 'Only assessors, garages and suppliers can submit invoices');
  }

  const { claim: claimId, items, taxRate = 0, currency, notes, attachments } = req.body;

  if (!claimId) throw new ApiError(400, 'A claim reference is required');
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'At least one line item is required');
  }
  for (const item of items) {
    if (!item.description || item.quantity == null || item.unitPrice == null) {
      throw new ApiError(400, 'Each item needs a description, quantity and unitPrice');
    }
    if (item.quantity < 1 || item.unitPrice < 0) {
      throw new ApiError(400, 'Item quantity must be >= 1 and unitPrice >= 0');
    }
  }

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

  if (!vendorIsOnClaim(vendorType, actor.id, claim)) {
    throw new ApiError(403, 'You are not assigned to this claim');
  }

  const { itemsWithTotal, subtotal, tax, total } = computeTotals(items, taxRate);

  const invoice = await VendorInvoice.create({
    vendorType,
    vendor: actor.id,
    company: companyId,
    claim: claimId,
    items: itemsWithTotal,
    subtotal,
    taxRate,
    tax,
    total,
    currency: currency || 'KES',
    attachments,
    notes,
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
