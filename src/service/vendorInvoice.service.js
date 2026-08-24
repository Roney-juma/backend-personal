const VendorInvoice = require('../models/vendorInvoice.model');
const Claim = require('../models/claim.model');
const SupplyBid = require('../models/supplyBids.model');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');
const Advocate = require('../models/advocate.model');
const LegalCase = require('../models/legalCase.model');
const notificationService = require('./notification.service');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');

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
  // Counsel's fee note is the same payable every other vendor raises, but it is
  // the one type whose amount cannot be derived — see resolveAwardedAmount.
  Advocate: { model: Advocate, companyField: 'company', recipientType: 'advocate' },
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
 * Whether a vendor is eligible to invoice a given claim — deliberately tied to
 * the concrete fact of THEIR job being done on that car, not to the claim's
 * overall status (a claim's status can move on for other reasons — e.g. a
 * fraud investigation — without affecting whether the assessor/garage/supplier
 * already did their part and is owed for it):
 *   - Assessor: eligible only once they've submitted the RE-assessment report.
 *   - Garage:   eligible once they've submitted the repair report (repair done).
 *   - Supplier: eligible once their parts delivery is confirmed (or, for a
 *               glass job, once the glass replacement is completed).
 */
const isVendorEligible = async (vendorType, vendorId, claim) => {
  switch (vendorType) {
    case 'Assessor':
      return (
        idEq(claim.reAssessmentReport?.assessorId, vendorId) &&
        Boolean(claim.reAssessmentReport?.submittedAt)
      );
    case 'Garage':
      return (
        idEq(claim.garageRepairReport?.garageId, vendorId) &&
        Boolean(claim.garageRepairReport?.submittedAt)
      );
    case 'Supplier': {
      const glassDone =
        idEq(claim.glassRepair?.supplierId, vendorId) &&
        claim.glassRepair?.status === 'Completed';
      if (glassDone) return true;
      return Boolean(
        await SupplyBid.exists({
          claimId: claim._id,
          supplierId: vendorId,
          status: 'Delivered',
        })
      );
    }

    /**
     * Counsel may bill once they have actually taken the instruction.
     *
     * Deliberately NOT "once the matter is closed": a matter runs for years and
     * counsel raises interim fee notes throughout — after a hearing, on filing a
     * defence. Waiting for closure would mean an advocate could not bill until
     * the case ended, which no firm would accept.
     */
    case 'Advocate':
      return Boolean(
        await LegalCase.exists({
          claim: claim._id,
          advocate: vendorId,
          instructionsAcceptedAt: { $exists: true, $ne: null },
        })
      );
    default:
      return false;
  }
};

// Statuses that count as "already invoiced" for a claim — block a duplicate
// submission, but a rejected or withdrawn (cancelled) invoice may be re-raised.
const ACTIVE_INVOICE_STATUSES = ['submitted', 'approved', 'paid'];

/**
 * Counsel's fee note, which is the one invoice on this platform whose amount is
 * STATED rather than derived.
 *
 * Every other vendor here bid for the work, so the figure is whatever was
 * awarded and the vendor cannot move it. Legal fees have no bid: they are court
 * scale, an hourly record, or a negotiated retainer, and none of that is
 * knowable from the claim. So the advocate states it and gives a breakdown.
 *
 * What replaces the guarantee is the approval step that already exists — a fee
 * note is `submitted` until the insurer approves it, and nothing is paid on
 * counsel's word alone. The rate agreement on the advocate record is the
 * yardstick the approver checks it against.
 */
const resolveAdvocateFee = (body) => {
  const supplied = Array.isArray(body.items) ? body.items : [];

  const items = supplied
    .map((i) => {
      const quantity = Number(i.quantity) > 0 ? Number(i.quantity) : 1;
      const unitPrice = round2(i.unitPrice ?? i.amount ?? i.total);
      return {
        description: String(i.description || '').trim() || 'Legal fees',
        quantity,
        unitPrice,
        total: round2(quantity * unitPrice),
      };
    })
    .filter((i) => i.total > 0)
    .slice(0, 50);

  if (items.length) {
    const subtotal = round2(items.reduce((sum, i) => sum + i.total, 0));
    return { items, subtotal, total: subtotal };
  }

  // A single figure with no breakdown is accepted but must still be described,
  // so an approver is never asked to sign off an unexplained number.
  const flat = round2(body.amount ?? body.total);
  if (!(flat > 0)) return { items: [], subtotal: 0, total: 0 };
  return oneLine(String(body.description || '').trim() || 'Legal fees', flat);
};

/**
 * Build the invoice line items from the vendor's *awarded bid* on this claim, so
 * the amount always reflects what was agreed — never a figure typed by the vendor.
 * Not used for Advocate, who had no bid to award — see resolveAdvocateFee.
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
 * A vendor (assessor/garage/supplier) requests an invoice for a car they've
 * finished working on. Rules: their own job on that car must actually be done
 * (see isVendorEligible — this is independent of the claim's own status/stage),
 * only one active invoice per claim per vendor, a supporting document
 * (quote/invoice) is required, and the amount is taken from the vendor's
 * awarded bid — never from the request body.
 */
const createInvoice = async (req) => {
  const actor = req.user;
  const vendorType = actor.accountType;
  if (!isVendor(vendorType)) {
    throw new ApiError(403, 'Only assessors, garages, suppliers and panel advocates can submit invoices');
  }

  const { claim: claimId, notes, attachments } = req.body;
  if (!claimId) throw new ApiError(400, 'A claim reference is required');

  const cleanAttachments = Array.isArray(attachments)
    ? attachments.filter((a) => typeof a === 'string' && a.trim()).slice(0, 10)
    : [];
  if (!cleanAttachments.length) {
    throw new ApiError(400, 'A supporting document (quote/invoice) attachment is required');
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

  // Tenant guard: a vendor may only bill the insurer they're actually linked
  // to for a claim belonging to that same insurer (legacy claims/vendors with
  // no company on either side are exempt, matching the rest of the app).
  if (claim.company && !belongsToCompany(claim.company, companyId)) {
    throw new ApiError(403, 'This claim does not belong to your insurance company');
  }

  if (!(await isVendorEligible(vendorType, actor.id, claim))) {
    throw new ApiError(403, 'Your work on this car is not yet complete, or you are not assigned to it');
  }

  /**
   * One active invoice per claim per vendor — a rejected or withdrawn one may
   * be re-raised.
   *
   * Counsel is the exception: a matter runs for years and is billed in stages,
   * so only an UNDECIDED fee note blocks the next one. Once the insurer has
   * approved or paid it, the following stage may be billed.
   */
  const blocking = vendorType === 'Advocate' ? ['submitted'] : ACTIVE_INVOICE_STATUSES;
  const existing = await VendorInvoice.countDocuments({
    claim: claimId,
    vendor: actor.id,
    status: { $in: blocking },
  });
  if (existing > 0) {
    throw new ApiError(
      409,
      vendorType === 'Advocate'
        ? 'You already have a fee note awaiting a decision on this matter'
        : 'You have already submitted an invoice for this claim'
    );
  }

  // Derived from the awarded bid for everyone who bid for the work; stated by
  // counsel, who did not — see resolveAdvocateFee.
  const { items, subtotal, total } =
    vendorType === 'Advocate'
      ? resolveAdvocateFee(req.body)
      : await resolveAwardedAmount(vendorType, actor.id, claim);

  if (!(total > 0)) {
    throw new ApiError(
      400,
      vendorType === 'Advocate'
        ? 'State the fee — either itemised, or a single amount with a description'
        : 'No awarded bid amount was found for this claim'
    );
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
    attachments: cleanAttachments,
  });

  return invoice;
};

/**
 * Cars this vendor has finished work on and can raise an invoice for — i.e.
 * isVendorEligible(claim) is true and there's no active invoice for it yet.
 * Powers the "New Invoice" picker in the vendor's own app.
 */
const getEligibleClaims = async (req) => {
  const actor = req.user;
  const vendorType = actor.accountType;
  if (!isVendor(vendorType)) {
    throw new ApiError(403, 'Only assessors, garages, suppliers and panel advocates can request invoices');
  }

  // Tenant scope: a vendor only ever sees claims belonging to their own
  // insurance company (legacy vendors with no company keep the unscoped
  // behaviour — nothing to scope them to). Mirrors the cross-tenant guard
  // already enforced when bids/awards are made in the first place.
  const { model, companyField } = VENDORS[vendorType];
  const vendorDoc = await model.findById(actor.id).select(companyField).lean();
  const companyId = vendorDoc?.[companyField];
  const tenantScope = companyId ? { company: companyId } : {};

  let candidateClaims;
  if (vendorType === 'Assessor') {
    candidateClaims = await Claim.find({
      ...tenantScope,
      'reAssessmentReport.assessorId': actor.id,
      'reAssessmentReport.submittedAt': { $exists: true },
    }).lean();
  } else if (vendorType === 'Garage') {
    candidateClaims = await Claim.find({
      ...tenantScope,
      'garageRepairReport.garageId': actor.id,
      'garageRepairReport.submittedAt': { $exists: true },
    }).lean();
  } else if (vendorType === 'Advocate') {
    // Every accident counsel holds an accepted instruction on.
    const instructedClaimIds = await LegalCase.find({
      advocate: actor.id,
      instructionsAcceptedAt: { $exists: true, $ne: null },
    }).distinct('claim');
    candidateClaims = await Claim.find({
      ...tenantScope,
      _id: { $in: instructedClaimIds },
    }).lean();
  } else {
    const deliveredClaimIds = await SupplyBid.find({
      supplierId: actor.id,
      status: 'Delivered',
    }).distinct('claimId');
    candidateClaims = await Claim.find({
      ...tenantScope,
      $or: [
        { _id: { $in: deliveredClaimIds } },
        { 'glassRepair.supplierId': actor.id, 'glassRepair.status': 'Completed' },
      ],
    }).lean();
  }

  const invoicedClaimIds = new Set(
    (
      await VendorInvoice.find({
        vendor: actor.id,
        vendorType,
        status: { $in: ACTIVE_INVOICE_STATUSES },
      }).distinct('claim')
    ).map(String)
  );

  const eligible = candidateClaims.filter((c) => !invoicedClaimIds.has(String(c._id)));

  return Promise.all(
    eligible.map(async (claim) => {
      // Counsel has no awarded figure to pre-fill; they state the fee on the
      // form. Returning null rather than 0 so the client shows an empty field
      // instead of a zero someone might submit as-is.
      const total =
        vendorType === 'Advocate'
          ? null
          : (await resolveAwardedAmount(vendorType, actor.id, claim)).total;

      return {
        claimId: claim._id,
        status: claim.status,
        vehicle: claim.vehiclesInvolved?.[0] || null,
        location: claim.incidentDetails?.location,
        amount: total,
        // Tells the client whether to render a read-only amount or ask for one.
        amountIsFixed: vendorType !== 'Advocate',
        currency: 'KES',
      };
    })
  );
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
      .populate('claim', 'status incidentDetails vehiclesInvolved')
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
    .populate('claim', 'status incidentDetails vehiclesInvolved');
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
 * Insurance-company admin approves a submitted invoice, clearing it for payment.
 */
const approveInvoice = async (req, id) => {
  const actor = req.user;
  if (isVendor(actor.accountType)) {
    throw new ApiError(403, 'Only company admins can approve invoices');
  }
  const invoice = await VendorInvoice.findById(id);
  if (!invoice) throw new ApiError(404, 'Invoice not found');

  const company = await resolveAdminCompany(req);
  if (!belongsToCompany(invoice.company, company)) {
    throw new ApiError(403, 'This invoice was not billed to your company');
  }
  if (invoice.status !== 'submitted') {
    throw new ApiError(409, `Only a submitted invoice can be approved (this one is ${invoice.status})`);
  }

  invoice.status = 'approved';
  invoice.approvedAt = new Date();
  invoice.approvedBy = actor.id;
  await invoice.save();

  const { recipientType } = VENDORS[invoice.vendorType];
  notificationService
    .createAndEmit({
      recipientId: invoice.vendor,
      recipientType,
      type: 'invoice_approved',
      title: 'Invoice approved',
      content: `Invoice ${invoice.invoiceNumber} has been approved and is awaiting payment.`,
      claimId: invoice.claim,
    })
    .catch((err) => logger.warn('invoice_approved notification failed: %s', err.message));

  return invoice;
};

/**
 * Insurance-company admin rejects a submitted invoice, with a reason. The
 * vendor may correct and resubmit (createInvoice allows a fresh one once the
 * old one is no longer 'active').
 */
const rejectInvoice = async (req, id, { reason } = {}) => {
  const actor = req.user;
  if (isVendor(actor.accountType)) {
    throw new ApiError(403, 'Only company admins can reject invoices');
  }
  if (!reason || !reason.trim()) throw new ApiError(400, 'A rejection reason is required');

  const invoice = await VendorInvoice.findById(id);
  if (!invoice) throw new ApiError(404, 'Invoice not found');

  const company = await resolveAdminCompany(req);
  if (!belongsToCompany(invoice.company, company)) {
    throw new ApiError(403, 'This invoice was not billed to your company');
  }
  if (invoice.status !== 'submitted') {
    throw new ApiError(409, `Only a submitted invoice can be rejected (this one is ${invoice.status})`);
  }

  invoice.status = 'rejected';
  invoice.rejectedAt = new Date();
  invoice.rejectedBy = actor.id;
  invoice.rejectionReason = reason.trim();
  await invoice.save();

  const { recipientType } = VENDORS[invoice.vendorType];
  notificationService
    .createAndEmit({
      recipientId: invoice.vendor,
      recipientType,
      type: 'invoice_rejected',
      title: 'Invoice rejected',
      content: `Invoice ${invoice.invoiceNumber} was rejected: ${reason.trim()}`,
      claimId: invoice.claim,
    })
    .catch((err) => logger.warn('invoice_rejected notification failed: %s', err.message));

  return invoice;
};

/**
 * Insurance-company admin marks an approved invoice paid.
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
  if (invoice.status !== 'approved') {
    throw new ApiError(409, `Only an approved invoice can be paid (this one is ${invoice.status})`);
  }

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
  getEligibleClaims,
  getInvoices,
  getInvoiceById,
  approveInvoice,
  rejectInvoice,
  markAsPaid,
  cancelInvoice,
  // Exported for the checks in scripts/test-legal-litigation.js — this is the
  // only vendor amount taken from the request, so it is worth pinning down.
  resolveAdvocateFee,
};
