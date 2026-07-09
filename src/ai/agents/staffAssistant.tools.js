/**
 * Read-only tools for the front-office staff assistant.
 *
 * Every tool returns COMPACT, capped, projected data to keep token cost low.
 * Safety: never call claim.service.getClaims() (it has auto-award side effects)
 * and never dump full collections — use lean, capped queries / stats helpers.
 */
const claimService = require('../../service/claim.service');
const customerService = require('../../service/customerService');
const garageService = require('../../service/garage.service');
const assessorService = require('../../service/assessor.service');
const supplierService = require('../../service/supplier.service');
const investigatorService = require('../../service/investigator.service');
const Claim = require('../../models/claim.model');
const Customer = require('../../models/customerModel');

const CLAIM_STATUSES = [
  'Pending', 'Approved', 'Rejected', 'Resubmitted', 'Assessment', 'Assessed',
  'Awarded', 'Repair', 'Garage', 'Re-Assessment', 'ReAssessed', 'SelfRepair', 'UnderRepair',
  'Completed', 'UnderInvestigation', 'Investigated', 'GlassApproved', 'GlassRepair',
];

// ---------- compact mappers ----------
const vehStr = (v) => (v ? [v.make, v.model, v.year, v.licensePlate].filter(Boolean).join(' ') : null);

const claimRow = (c) => ({
  id: c._id,
  status: c.status,
  claimant: c.claimant?.name,
  vehicle: vehStr((c.vehiclesInvolved || [])[0]),
  selfRepair: c.selfRepair?.status,
  fraudSuspected: !!(c.fraud && c.fraud.suspected),
  createdAt: c.createdAt,
});

const claimDetail = (c) => ({
  id: c._id,
  status: c.status,
  claimant: { name: c.claimant?.name, phone: c.claimant?.phone, email: c.claimant?.email },
  vehicles: (c.vehiclesInvolved || []).map(vehStr),
  incident: c.incidentDetails
    ? { date: c.incidentDetails.date, location: c.incidentDetails.location, description: c.incidentDetails.description }
    : null,
  awardedAssessor: c.awardedAssessor?.assessorId ? { amount: c.awardedAssessor.awardedAmount, date: c.awardedAssessor.awardedDate } : null,
  awardedGarage: c.awardedGarage?.garageId ? { amount: c.awardedGarage.awardedAmount, date: c.awardedGarage.awardedDate } : null,
  selfRepair: c.selfRepair?.status,
  glass: c.glassRepair?.status,
  fraudSuspected: !!(c.fraud && c.fraud.suspected),
  createdAt: c.createdAt,
});

const cap = (arr, n = 20) => (Array.isArray(arr) ? arr.slice(0, n) : []);
const ok = (data) => ({ content: JSON.stringify(data) });
const fail = (msg) => ({ content: JSON.stringify({ error: msg }), isError: true });

// ---------- tool schemas (sent to the model) ----------
const TOOLS = [
  { name: 'get_claim', description: 'Get the full status and details of one claim by its ID.',
    input_schema: { type: 'object', properties: { claimId: { type: 'string' } }, required: ['claimId'] } },
  { name: 'search_claims', description: 'Search/list claims by status and/or customer. Returns up to 20 compact rows.',
    input_schema: { type: 'object', properties: {
      status: { type: 'string', enum: CLAIM_STATUSES },
      customerEmail: { type: 'string' }, customerName: { type: 'string' },
      limit: { type: 'number' } } } },
  { name: 'count_claims_by_status', description: 'Count of claims grouped by status (whole platform).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'claim_bids', description: 'Summary of assessor, garage and supplier bids on a claim.',
    input_schema: { type: 'object', properties: { claimId: { type: 'string' } }, required: ['claimId'] } },
  { name: 'claim_payment_totals', description: 'Total payouts across awarded claims (garage/assessor/supplier). Heavier query.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'find_customer', description: 'Find customers by email, phone, or name. Returns up to 5 compact records.',
    input_schema: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string' }, name: { type: 'string' } } } },
  { name: 'customer_claims', description: 'List a customer\'s claims by customer ID (up to 20).',
    input_schema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] } },
  { name: 'customer_stats', description: 'Customer counts: total, new this month, recurring.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'assessor_stats', description: 'Assessor counts: total, busy, free.', input_schema: { type: 'object', properties: {} } },
  { name: 'top_assessors', description: 'Top 10 assessors by claims assessed.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_assessor', description: 'Get one assessor by ID.',
    input_schema: { type: 'object', properties: { assessorId: { type: 'string' } }, required: ['assessorId'] } },
  { name: 'garage_stats', description: 'Garage stats: count, with pending work, average rating.', input_schema: { type: 'object', properties: {} } },
  { name: 'top_garages', description: 'Top 10 garages by claims repaired.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_garages', description: 'List garages, optional city filter. Returns up to 20.',
    input_schema: { type: 'object', properties: { city: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'list_suppliers', description: 'List suppliers (up to 20).', input_schema: { type: 'object', properties: {} } },
  { name: 'investigator_stats', description: 'Investigator stats: total, active, idle, active investigations, awaiting review.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_investigations', description: 'List investigations (up to 20).', input_schema: { type: 'object', properties: {} } },
  { name: 'get_investigation', description: 'Get one investigation by ID.',
    input_schema: { type: 'object', properties: { investigationId: { type: 'string' } }, required: ['investigationId'] } },
];

// ---------- executor ----------
async function executeTool(block) {
  const a = block.input || {};
  try {
    switch (block.name) {
      case 'get_claim': {
        const c = await claimService.getClaimById(a.claimId);
        return ok(claimDetail(c));
      }
      case 'search_claims': {
        const filter = {};
        if (a.status) filter.status = a.status;
        if (a.customerEmail) filter['claimant.email'] = a.customerEmail;
        if (a.customerName) filter['claimant.name'] = new RegExp(a.customerName, 'i');
        const limit = Math.min(a.limit || 20, 50);
        const rows = await Claim.find(filter)
          .select('status claimant vehiclesInvolved createdAt selfRepair.status fraud.suspected')
          .sort({ createdAt: -1 }).limit(limit).lean();
        return ok({ count: rows.length, claims: rows.map(claimRow) });
      }
      case 'count_claims_by_status':
        return ok(await claimService.countClaimsByStatus());
      case 'claim_bids': {
        const out = {};
        try { out.assessor = (await claimService.getBidsByClaim(a.claimId))?.bids?.map((b) => ({ amount: b.amount, status: b.status, rating: b.ratings })) || []; } catch (e) { out.assessor = []; }
        try { out.garage = (await claimService.getGarageBidsByClaim(a.claimId))?.map((b) => ({ amount: b.amount, status: b.status, rating: b.ratings })) || []; } catch (e) { out.garage = []; }
        try { out.supplier = (await claimService.getSupplierBidsForClaim(a.claimId))?.map((b) => ({ total: b.totalCost, status: b.status })) || []; } catch (e) { out.supplier = []; }
        return ok(out);
      }
      case 'claim_payment_totals':
        return ok(await claimService.getPaymentTotals());
      case 'find_customer': {
        const or = [];
        if (a.email) or.push({ email: new RegExp(`^${a.email}$`, 'i') });
        if (a.phone) or.push({ phone: a.phone });
        if (a.name) or.push({ firstName: new RegExp(a.name, 'i') }, { lastName: new RegExp(a.name, 'i') });
        if (or.length === 0) return fail('Provide email, phone, or name.');
        const rows = await Customer.find({ $or: or })
          .select('firstName lastName email phone policyNumber policyType').limit(5).lean();
        return ok({ count: rows.length, customers: rows.map((c) => ({ id: c._id, name: `${c.firstName || ''} ${c.lastName || ''}`.trim(), email: c.email, phone: c.phone, policyNumber: c.policyNumber, policyType: c.policyType })) });
      }
      case 'customer_claims': {
        let claims = [];
        try { claims = await customerService.getCustomerClaims(a.customerId); } catch (e) { claims = []; }
        return ok({ count: claims.length, claims: cap(claims).map(claimRow) });
      }
      case 'customer_stats':
        return ok(await customerService.getCustomerStats());
      case 'assessor_stats':
        return ok(await assessorService.getAssessorStatistics());
      case 'top_assessors':
        return ok(await assessorService.getTopAssessors());
      case 'get_assessor': {
        const x = await assessorService.getAssessorById(a.assessorId);
        return ok({ id: x._id, name: x.name, email: x.email, rating: x.ratings?.averageRating, city: x.location?.city, pendingWork: x.pendingWork });
      }
      case 'garage_stats':
        return ok(await garageService.getGarageStats());
      case 'top_garages':
        return ok(await garageService.getTopGarages());
      case 'list_garages': {
        const r = await garageService.getAllGarages({ city: a.city }, 1, Math.min(a.limit || 20, 50));
        const list = r?.garages || r || [];
        return ok({ count: list.length, garages: cap(list).map((g) => ({ id: g._id, name: g.name, city: g.location?.city, rating: g.ratings?.averageRating, pendingWork: g.pendingWork })) });
      }
      case 'list_suppliers': {
        const r = await supplierService.getAllSuppliers({ page: 1, limit: Math.min(a.limit || 20, 50) });
        const list = r?.suppliers || r || [];
        return ok({ count: list.length, suppliers: cap(list).map((s) => ({ id: s._id, name: s.name, email: s.email })) });
      }

      case 'investigator_stats':
        return ok(await investigatorService.getInvestigatorStats());
      case 'list_investigations': {
        const list = await investigatorService.getAllInvestigations();
        return ok({ count: (list || []).length, investigations: cap(list).map((i) => ({ id: i._id, claimId: i.claimId?._id || i.claimId, status: i.status, investigator: i.investigatorId?.name })) });
      }
      case 'get_investigation': {
        const i = await investigatorService.getInvestigationById(a.investigationId);
        return ok({ id: i._id, claimId: i.claimId?._id || i.claimId, status: i.status, conclusion: i.report?.conclusion, investigator: i.investigatorId?.name });
      }
      default:
        return fail(`Unknown tool: ${block.name}`);
    }
  } catch (err) {
    return fail(err.message);
  }
}

module.exports = { TOOLS, executeTool };
