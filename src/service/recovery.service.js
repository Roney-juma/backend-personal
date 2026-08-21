const Recovery = require('../models/recovery.model');
const Claim = require('../models/claim.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const legalLedger = require('./legalLedger.service');
const legalConfig = require('./legalConfig.service');
const limitation = require('./limitation.service');

/**
 * Subrogation — recovering what we paid out from whoever was actually at fault.
 *
 * The commercial point of the whole module sits here: everything upstream
 * measures what an accident costs, and this is the only part that reduces it.
 * A legal function judged solely on claims paid looks like pure cost; judged
 * with recoveries it looks like what it is.
 */

/**
 * Open a recovery.
 *
 * `recoverableMinor` defaults to the outlay reduced by our own insured's share
 * of the fault, rather than to the full outlay. Recording 100% of an outlay as
 * recoverable on a 70:30 accident makes the recovery report overstate the target
 * and then understate the result — a recovery rate against a number that was
 * never achievable tells you nothing.
 */
async function create(data, actor = null) {
  const claim = await Claim.findById(data.claim);
  if (!claim) throw new ApiError(404, 'Claim not found');
  if (!claim.company) throw new ApiError(400, 'That claim has no insurer — cannot scope a recovery');

  if (!data.recoverFrom?.name || !data.recoverFrom?.type) {
    throw new ApiError(400, 'A recovery needs to say who it is against');
  }

  const outlayMinor = toMinorAmount(data, 'outlay');
  const sharePercent = Number(data.ourInsuredSharePercent ?? 0);
  const recoverableMinor = Number.isInteger(data.recoverableMinor)
    ? data.recoverableMinor
    : data.recoverable !== undefined
      ? money.toMinor(data.recoverable)
      : money.applyPercent(outlayMinor, 100 - sharePercent);

  if (recoverableMinor > outlayMinor) {
    throw new ApiError(400, 'The recoverable amount cannot exceed what we actually paid out');
  }

  const reference = await Counter.nextReference({ prefix: 'REC', company: claim.company });

  const recovery = await Recovery.create({
    reference,
    company: claim.company,
    claim: claim._id,
    thirdPartyClaim: data.thirdPartyClaim,
    recoverFrom: data.recoverFrom,
    basis: data.basis || 'negligence',
    basisNotes: data.basisNotes,
    outlayMinor,
    recoverableMinor,
    ourInsuredSharePercent: sharePercent,
    identifiedBy: actor?._id || actor?.id || null,
    handler: data.handler || actor?._id || actor?.id || null,
    notes: data.notes,
    limitation: await recoveryLimitation(claim, data),
  });

  logger.info(
    `[recovery] ${reference} opened against ${recovery.recoverFrom.name} — ` +
    `${money.formatMinor(recoverableMinor)} recoverable of ${money.formatMinor(outlayMinor)} paid`
  );
  return recovery;
}

/**
 * Our own limitation clock on the recovery.
 *
 * Uses the tenant's property-damage period as the default basis: a subrogated
 * claim is usually pursued in the insured's name on the same footing they would
 * have had. Configurable, and the resulting date rides the ordinary reminder
 * ladder like everything else.
 */
async function recoveryLimitation(claim, data) {
  try {
    const accrualDate = data.accrualDate || claim.incidentDetails?.date;
    if (!accrualDate) return undefined;

    const months = await legalConfig.limitationMonths(claim.company, 'property_damage');
    return {
      accrualDate: new Date(accrualDate),
      expiresAt: limitation.addMonths(new Date(accrualDate), months),
    };
  } catch (err) {
    logger.warn(`[recovery] could not compute limitation: ${err.message}`);
    return undefined;
  }
}

/** Record a demand or a chase. */
async function chase(recoveryId, { channel, notes, response, isDemand }, actor = null) {
  const recovery = await Recovery.findById(recoveryId);
  if (!recovery) throw new ApiError(404, 'Recovery not found');
  if (['recovered', 'written_off', 'abandoned'].includes(recovery.status)) {
    throw new ApiError(409, `That recovery is ${recovery.status.replace(/_/g, ' ')} and is closed`);
  }

  recovery.chases.push({
    at: new Date(),
    channel: channel || 'letter',
    notes,
    response,
    by: actor?._id || actor?.id || null,
  });
  recovery.lastChasedAt = new Date();

  if (isDemand && !recovery.demandSentAt) {
    recovery.demandSentAt = new Date();
    recovery.status = 'demand_sent';
  } else if (recovery.status === 'identified') {
    recovery.status = 'demand_sent';
  }

  await recovery.save();
  return recovery;
}

/** Record an agreed figure short of the full recoverable amount. */
async function agree(recoveryId, { amount, amountMinor, notes }, actor = null) {
  const recovery = await Recovery.findById(recoveryId);
  if (!recovery) throw new ApiError(404, 'Recovery not found');

  const agreedMinor = Number.isInteger(amountMinor) ? amountMinor : money.toMinor(amount);
  if (agreedMinor <= 0) throw new ApiError(400, 'An agreed recovery needs an amount');
  if (agreedMinor > recovery.recoverableMinor) {
    throw new ApiError(400, 'Cannot agree to recover more than the recoverable amount');
  }

  recovery.agreedMinor = agreedMinor;
  recovery.agreedAt = new Date();
  recovery.status = 'agreed';
  if (notes) recovery.notes = notes;
  await recovery.save();

  return recovery;
}

/**
 * Record money actually received.
 *
 * Posts a CREDIT to the legal ledger, which is what makes a matter's net
 * exposure fall as recovery comes in — the whole reason recoveries live on the
 * same ledger as the costs rather than in a separate table.
 *
 * Part payments are normal and cumulative.
 */
async function recordReceipt(recoveryId, { amount, amountMinor, reference, receivedAt }, actor = null) {
  const recovery = await Recovery.findById(recoveryId);
  if (!recovery) throw new ApiError(404, 'Recovery not found');

  const receiptMinor = Number.isInteger(amountMinor) ? amountMinor : money.toMinor(amount);
  if (receiptMinor <= 0) throw new ApiError(400, 'A receipt needs a positive amount');

  const alreadyIn = recovery.recoveredMinor || 0;
  if (alreadyIn + receiptMinor > recovery.recoverableMinor) {
    throw new ApiError(
      400,
      `That would take recoveries to ${money.formatMinor(alreadyIn + receiptMinor)}, ` +
      `above the ${money.formatMinor(recovery.recoverableMinor)} recoverable. ` +
      'Revise the recoverable amount first if more has genuinely come in.'
    );
  }

  await legalLedger.post(
    {
      company: recovery.company,
      claim: recovery.claim,
      thirdPartyClaim: recovery.thirdPartyClaim,
      legalCase: recovery.legalCase,
      entryType: 'recovery',
      amountMinor: receiptMinor,
      counterparty: { type: mapCounterparty(recovery.recoverFrom.type), name: recovery.recoverFrom.name },
      sourceRef: { model: 'Recovery', id: recovery._id },
      status: 'paid',
      description: `Recovery ${recovery.reference}` + (reference ? ` — ref ${reference}` : ''),
      occurredAt: receivedAt ? new Date(receivedAt) : new Date(),
    },
    actor
  );

  recovery.recoveredMinor = alreadyIn + receiptMinor;
  recovery.status =
    recovery.recoveredMinor >= recovery.recoverableMinor ? 'recovered' : 'part_recovered';
  if (recovery.status === 'recovered') recovery.closedAt = new Date();
  await recovery.save();

  logger.info(
    `[recovery] ${recovery.reference} received ${money.formatMinor(receiptMinor)} — ` +
    `${money.formatMinor(recovery.recoveredMinor)} of ${money.formatMinor(recovery.recoverableMinor)}`
  );
  return recovery;
}

/**
 * Write off what will not be recovered.
 *
 * A reasoned, permissioned act rather than a quiet status change: writing off a
 * recoverable amount is a decision to stop pursuing money the insurer is owed,
 * and it should look like one. The write-off posts to the ledger so the matter's
 * final position is honest about what was given up.
 */
async function writeOff(recoveryId, { amount, amountMinor, reason }, actor = null) {
  if (!String(reason || '').trim()) {
    throw new ApiError(400, 'Writing off a recovery requires a reason');
  }

  const recovery = await Recovery.findById(recoveryId);
  if (!recovery) throw new ApiError(404, 'Recovery not found');

  const outstanding =
    recovery.recoverableMinor - (recovery.recoveredMinor || 0) - (recovery.writtenOffMinor || 0);
  const writeOffMinor = Number.isInteger(amountMinor)
    ? amountMinor
    : amount !== undefined
      ? money.toMinor(amount)
      : outstanding;

  if (writeOffMinor <= 0) throw new ApiError(400, 'There is nothing outstanding to write off');
  if (writeOffMinor > outstanding) {
    throw new ApiError(400, `Only ${money.formatMinor(outstanding)} is outstanding`);
  }

  await legalLedger.post(
    {
      company: recovery.company,
      claim: recovery.claim,
      thirdPartyClaim: recovery.thirdPartyClaim,
      legalCase: recovery.legalCase,
      entryType: 'write_off',
      amountMinor: writeOffMinor,
      sourceRef: { model: 'Recovery', id: recovery._id },
      status: 'approved',
      description: `Write-off on ${recovery.reference}: ${reason}`,
    },
    actor
  );

  recovery.writtenOffMinor = (recovery.writtenOffMinor || 0) + writeOffMinor;
  recovery.writeOffReason = reason;
  recovery.writeOffApprovedBy = actor?._id || actor?.id || null;

  const stillOut =
    recovery.recoverableMinor - (recovery.recoveredMinor || 0) - recovery.writtenOffMinor;
  if (stillOut <= 0) {
    recovery.status = recovery.recoveredMinor > 0 ? 'part_recovered' : 'written_off';
    recovery.closedAt = new Date();
  }
  await recovery.save();

  logger.warn(
    `[recovery] ${recovery.reference} write-off of ${money.formatMinor(writeOffMinor)} — ${reason}`
  );
  return recovery;
}

/** Recovery expenses reduce the net benefit and belong on the same ledger. */
async function recordExpense(recoveryId, { amount, amountMinor, description }, actor = null) {
  const recovery = await Recovery.findById(recoveryId);
  if (!recovery) throw new ApiError(404, 'Recovery not found');

  const expenseMinor = Number.isInteger(amountMinor) ? amountMinor : money.toMinor(amount);
  if (expenseMinor <= 0) throw new ApiError(400, 'An expense needs a positive amount');

  await legalLedger.post(
    {
      company: recovery.company,
      claim: recovery.claim,
      thirdPartyClaim: recovery.thirdPartyClaim,
      legalCase: recovery.legalCase,
      entryType: 'disbursement',
      amountMinor: expenseMinor,
      sourceRef: { model: 'Recovery', id: recovery._id },
      status: 'accrued',
      description: description || `Recovery expense on ${recovery.reference}`,
    },
    actor
  );

  recovery.expensesMinor = (recovery.expensesMinor || 0) + expenseMinor;
  await recovery.save();
  return recovery;
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function list({ company, status, claim, handler, page = 1, limit = 25 }) {
  const filter = {};
  if (company) filter.company = company;
  if (status) filter.status = Array.isArray(status) ? { $in: status } : status;
  if (claim) filter.claim = claim;
  if (handler) filter.handler = handler;

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Recovery.find(filter).sort({ identifiedAt: 1 }).skip(skip).limit(Number(limit)).lean({ virtuals: true }),
    Recovery.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) };
}

async function getById(id) {
  const recovery = await Recovery.findById(id)
    .populate('claim', 'incidentDetails vehiclesInvolved')
    .lean({ virtuals: true });
  if (!recovery) throw new ApiError(404, 'Recovery not found');
  return recovery;
}

/**
 * The recovery position for a tenant.
 *
 * Reports recovery RATE against what was realistically recoverable, not against
 * total outlay — see the note on create(). A rate computed against an
 * unachievable target makes a good recovery function look like a failing one.
 */
async function position({ company }) {
  const rows = await Recovery.aggregate([
    { $match: { company: toObjectId(company), deletedAt: null } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        outlayMinor: { $sum: '$outlayMinor' },
        recoverableMinor: { $sum: '$recoverableMinor' },
        recoveredMinor: { $sum: '$recoveredMinor' },
        writtenOffMinor: { $sum: '$writtenOffMinor' },
        expensesMinor: { $sum: '$expensesMinor' },
      },
    },
  ]);

  const totals = rows.reduce(
    (acc, r) => ({
      count: acc.count + r.count,
      outlayMinor: acc.outlayMinor + r.outlayMinor,
      recoverableMinor: acc.recoverableMinor + r.recoverableMinor,
      recoveredMinor: acc.recoveredMinor + r.recoveredMinor,
      writtenOffMinor: acc.writtenOffMinor + r.writtenOffMinor,
      expensesMinor: acc.expensesMinor + r.expensesMinor,
    }),
    { count: 0, outlayMinor: 0, recoverableMinor: 0, recoveredMinor: 0, writtenOffMinor: 0, expensesMinor: 0 }
  );

  const outstandingMinor = Math.max(
    0,
    totals.recoverableMinor - totals.recoveredMinor - totals.writtenOffMinor
  );

  return {
    ...totals,
    outstandingMinor,
    outstanding: money.toMajor(outstandingMinor),
    recovered: money.toMajor(totals.recoveredMinor),
    // Against the recoverable target, not the outlay.
    recoveryRatePercent: totals.recoverableMinor
      ? Math.round((totals.recoveredMinor / totals.recoverableMinor) * 1000) / 10
      : 0,
    netBenefitMinor: totals.recoveredMinor - totals.expensesMinor,
    netBenefit: money.toMajor(totals.recoveredMinor - totals.expensesMinor),
    byStatus: rows.map((r) => ({
      status: r._id,
      count: r.count,
      recoverableMinor: r.recoverableMinor,
      recoveredMinor: r.recoveredMinor,
    })),
    formatted: {
      outstanding: money.formatMinor(outstandingMinor),
      recovered: money.formatMinor(totals.recoveredMinor),
      netBenefit: money.formatMinor(totals.recoveredMinor - totals.expensesMinor),
    },
  };
}

/**
 * Recoveries that have gone quiet — chased once and then forgotten, or never
 * chased at all. This is where recovery money is actually lost.
 */
async function stale({ company, quietDays = 45 }) {
  const cutoff = new Date(Date.now() - quietDays * 86400000);

  const recoveries = await Recovery.find({
    company,
    status: { $in: ['identified', 'demand_sent', 'negotiating', 'part_recovered'] },
    $or: [
      { lastChasedAt: { $lt: cutoff } },
      { lastChasedAt: null, identifiedAt: { $lt: cutoff } },
    ],
  })
    .sort({ lastChasedAt: 1, identifiedAt: 1 })
    .limit(200)
    .lean({ virtuals: true });

  return recoveries.map((r) => ({
    ...r,
    quietDays: Math.floor(
      (Date.now() - new Date(r.lastChasedAt || r.identifiedAt).getTime()) / 86400000
    ),
    daysToTimeBar: r.limitation?.expiresAt
      ? Math.ceil((new Date(r.limitation.expiresAt).getTime() - Date.now()) / 86400000)
      : null,
  }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Recovery target types map onto the ledger's counterparty vocabulary. */
function mapCounterparty(type) {
  const MAP = {
    third_party_insurer: 'third_party_insurer',
    driver: 'driver',
    employer: 'employer',
    manufacturer: 'manufacturer',
    garage: 'garage',
  };
  return MAP[type] || 'other';
}

function toMinorAmount(data, key) {
  const minorKey = `${key}Minor`;
  if (Number.isInteger(data[minorKey])) return data[minorKey];
  if (data[key] !== undefined && data[key] !== null && data[key] !== '') return money.toMinor(data[key]);
  throw new ApiError(400, `${key} is required`);
}

function toObjectId(v) {
  const mongoose = require('mongoose');
  return v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));
}

module.exports = {
  create,
  chase,
  agree,
  recordReceipt,
  writeOff,
  recordExpense,
  list,
  getById,
  position,
  stale,
};
