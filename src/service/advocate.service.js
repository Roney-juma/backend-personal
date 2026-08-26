const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Advocate = require('../models/advocate.model');
const LegalCase = require('../models/legalCase.model');
const LegalEvent = require('../models/legalEvent.model');
const Settlement = require('../models/settlement.model');
const LegalLedgerEntry = require('../models/legalLedgerEntry.model');
const ApiError = require('../utils/ApiError');
const { searchRegex } = require('../utils/searchRegex');
const logger = require('../middlewheres/logger');
const money = require('../utils/money');
const legalConfig = require('./legalConfig.service');
const { DEFAULT_ALLOCATION_WEIGHTS } = require('../constants/legal.constants');

/**
 * The advocate panel and the allocation engine.
 *
 * Panels are per-tenant and confidential: unlike garages and assessors there is
 * no cross-tenant marketplace and no competitive bidding, because one insurer
 * must not see which advocates another instructs, nor which matters they are
 * defending.
 *
 * Allocation is still assisted rather than arbitrary. AVE Africa asked for the
 * same parameters that drive assessor selection — location, current workload,
 * past performance, savings and successful defences — plus a random mode. Both
 * are here, and both leave the appointer free to override.
 */

// ── Panel ────────────────────────────────────────────────────────────────────

/**
 * A temporary portal password.
 *
 * Generated per advocate rather than using a shared default: these credentials
 * open privileged case files, and one well-known starting password across a
 * whole panel is a password everybody already knows. Ambiguous glyphs are left
 * out because this gets read off a screen and typed by hand.
 */
function generateTempPassword() {
  // No 0/O and no 1/l/I anywhere, including the digits on the end — the pair is
  // what makes either one ambiguous when read off a screen.
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const DIGITS = '23456789';
  const pick = (set, n) =>
    Array.from(crypto.randomBytes(n), (b) => set[b % set.length]).join('');

  // The symbol and the trailing digits are fixed positions rather than left to
  // chance, so the value still satisfies a tightened password policy later.
  return `${pick(LETTERS, 12)}#${pick(DIGITS, 2)}`;
}

async function create(data, actor = null) {
  if (!data.company) throw new ApiError(400, 'An advocate belongs to one insurer\'s panel');
  if (!data.firm?.name) throw new ApiError(400, 'The firm name is required');
  if (!data.email) throw new ApiError(400, 'An email address is required — portal credentials are sent to it');

  const existing = await Advocate.findOne({ company: data.company, email: data.email?.toLowerCase() });
  if (existing) {
    throw new ApiError(409, 'That advocate is already on this panel');
  }

  // `sendCredentials: false` lets a bulk panel import run without mailing every
  // advocate at once; the credentials endpoint issues them individually later.
  const withCredentials = data.sendCredentials !== false;
  const tempPassword = withCredentials ? generateTempPassword() : null;
  delete data.sendCredentials;

  const advocate = await Advocate.create({
    ...data,
    email: data.email.toLowerCase(),
    // Approval is a separate, deliberate act — adding someone to the list is not
    // the same as clearing them to receive instructions. It gates ALLOCATION,
    // not sign-in: a new panel member can reach the portal and simply has no
    // matters in it until they are instructed.
    approved: false,
    active: true,
    ...(withCredentials
      ? {
          password: await bcrypt.hash(tempPassword, 10),
          active_account: true,
          mustChangePassword: true,
        }
      : {}),
  });

  logger.info(`[advocate] ${advocate.name} (${advocate.firm.name}) added to panel for ${data.company}`);

  if (withCredentials) {
    // Deliberately not awaited: a mail failure must not fail the creation and
    // leave the caller retrying a name that is now a duplicate. The password can
    // always be reissued from the panel screen.
    sendCredentials(advocate, tempPassword).catch((err) =>
      logger.error(`[advocate] credentials for ${advocate.email} could not be sent: ${err.message}`)
    );
  }

  return advocate;
}

async function update(id, changes, actor = null) {
  const advocate = await Advocate.findById(id);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  // These have their own flows and must not be settable through a general update.
  // active_account and mustChangePassword are on the list because portal access
  // now exists from the moment an advocate is added: without them, an ordinary
  // panel edit could silently switch an account on, or clear the forced password
  // change, without going through the credentials path or its audit entry.
  const PROTECTED = [
    'company', 'performance', 'password', 'mfaSecret', 'accountType',
    'approved', 'active_account', 'mustChangePassword',
  ];
  for (const key of PROTECTED) delete changes[key];

  Object.assign(advocate, changes);
  await advocate.save();
  return advocate;
}

async function setApproval(id, approved, actor = null) {
  const advocate = await Advocate.findById(id);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  advocate.approved = Boolean(approved);
  advocate.approvedAt = approved ? new Date() : undefined;
  advocate.approvedBy = approved ? actor?._id || actor?.id || null : undefined;
  await advocate.save();

  logger.info(`[advocate] ${advocate.name} ${approved ? 'approved for' : 'removed from'} panel duty`);
  return advocate;
}

async function suspend(id, reason, actor = null) {
  if (!String(reason || '').trim()) throw new ApiError(400, 'Suspending an advocate requires a reason');

  const advocate = await Advocate.findById(id);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  // Suspension excludes from allocation but keeps every historical matter and
  // its performance record — those still explain past outcomes.
  advocate.active = false;
  advocate.suspendedAt = new Date();
  advocate.suspensionReason = reason;
  await advocate.save();

  const open = await LegalCase.countDocuments({
    advocate: advocate._id,
    status: { $nin: ['closed', 'resolution'] },
  });

  logger.warn(`[advocate] ${advocate.name} suspended — ${reason} (${open} open matters remain assigned)`);
  return { advocate, openMattersRemaining: open };
}

/**
 * Remove an advocate from the panel.
 *
 * A soft delete, like every other delete on the platform: closed matters keep
 * pointing at whoever defended them, and the reason a case settled where it did
 * is not something to destroy because a contract ended years later.
 *
 * Refused while the advocate still holds open matters. Deleting counsel in the
 * middle of live litigation leaves court files with nobody answering for them,
 * and the diary still chasing progress reports from an advocate who is gone —
 * suspension is what an insurer actually wants in that situation, and it keeps
 * the history intact while excluding them from new work.
 *
 * @returns {Promise<{ advocate: Object, openMattersRemaining: number }>}
 */
async function remove(id, actor = null) {
  const advocate = await Advocate.findById(id);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  const open = await LegalCase.countDocuments({
    advocate: advocate._id,
    status: { $nin: ['closed', 'resolution'] },
  });
  if (open > 0) {
    throw new ApiError(
      409,
      `${advocate.name} is still counsel on ${open} open ${open === 1 ? 'matter' : 'matters'}. ` +
      'Reassign those matters, or suspend the advocate instead — suspending stops new instructions ' +
      'without abandoning live litigation.'
    );
  }

  // Revoke portal access as part of the removal. The soft-delete plugin already
  // hides the record from the login lookup, but a security property should not
  // rest on a query hook alone — and clearing the credentials means a later
  // restore has to issue new ones rather than silently reviving an old password.
  advocate.active_account = false;
  advocate.password = undefined;
  advocate.mfaSecret = undefined;
  advocate.fcmToken = undefined;
  advocate.active = false;
  await advocate.save();

  await Advocate.softDeleteById(advocate._id);

  logger.warn(
    `[advocate] ${advocate.name} (${advocate.firm?.name}) removed from the panel by ` +
    `${actor?.fullName || actor?.email || 'unknown'} — portal access revoked`
  );

  return { advocate, openMattersRemaining: 0 };
}

/**
 * The panel.
 *
 * Paginated like every other legal listing, and shaped the same way —
 * { items, total, page, pages } — so one component on the client can drive all
 * of them. A panel is small enough today that a caller may still ask for
 * everything at once with a large limit.
 */
async function list({ company, approved, active, search, county, court, page = 1, limit = 25 }) {
  const filter = { company };
  if (approved !== undefined) filter.approved = approved === true || approved === 'true';
  if (active !== undefined) filter.active = active === true || active === 'true';
  if (county) filter.counties = county;
  if (court) filter.courts = court;

  const rx = searchRegex(search);
  if (rx) {
    filter.$or = [
      { name: rx },
      { 'firm.name': rx },
      { email: rx },
      { lskNumber: rx },
      { 'firm.lskNumber': rx },
      { phone: rx },
    ];
  }

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Advocate.find(filter)
      .sort({ 'performance.rating': -1, name: 1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Advocate.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) || 1 };
}

async function getById(id) {
  const advocate = await Advocate.findById(id).lean();
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  const matters = await LegalCase.find({ advocate: id })
    .select('caseNumber court status filedAt closedAt judgment')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return { ...advocate, matters };
}

// ── Performance ──────────────────────────────────────────────────────────────

/**
 * Recompute one advocate's record from cases, settlements and the ledger.
 *
 * Never stored by hand and never trusted stale — every figure here is derived,
 * so an advocate cannot be advantaged in allocation by an out-of-date number.
 * Run nightly by the scheduler.
 */
async function recomputePerformance(advocateId) {
  const advocate = await Advocate.findById(advocateId);
  if (!advocate) return null;

  const CLOSED = ['closed', 'resolution'];

  const [cases, openMatters, overdueEvents, feeRows] = await Promise.all([
    LegalCase.find({ advocate: advocateId }).select('status filedAt closedAt judgment thirdPartyClaims').lean(),
    LegalCase.countDocuments({ advocate: advocateId, status: { $nin: CLOSED } }),
    LegalEvent.countDocuments({
      responsibleType: 'Advocate',
      responsible: advocateId,
      status: { $in: ['scheduled', 'pending', 'missed'] },
      dueAt: { $lt: new Date() },
    }),
    LegalLedgerEntry.aggregate([
      {
        $match: {
          entryType: 'legal_fee',
          'counterparty.type': 'advocate',
          'counterparty.id': advocate._id,
        },
      },
      { $group: { _id: null, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
  ]);

  const closed = cases.filter((c) => CLOSED.includes(c.status));

  // A "successful defence" is a judgment for the insurer or a dismissal — the
  // outcomes where the advocate actually won rather than merely concluded.
  const successfulDefences = closed.filter((c) =>
    ['for_insurer', 'dismissed', 'struck_out'].includes(c.judgment?.liabilityOutcome)
  ).length;

  /**
   * Win rate is measured over matters that reached a judgment, not over
   * everything that closed.
   *
   * Dividing by all closed matters counted every settlement as a loss — a
   * settled matter has no liabilityOutcome, so it landed in the denominator and
   * never the numerator. Most matters settle, so that punished exactly the
   * advocates who settle well and rewarded whoever took the most cases to
   * judgment. An advocate who settles everything favourably scored 0%.
   */
  const adjudicated = closed.filter((c) => c.judgment?.liabilityOutcome);
  const settledMatters = closed.length - adjudicated.length;

  const durations = closed
    .filter((c) => c.filedAt && c.closedAt)
    .map((c) => (new Date(c.closedAt) - new Date(c.filedAt)) / 86400000);
  const avgDurationDays = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  // Savings: what was reserved when the settlement was proposed, less what it
  // actually settled at. Straight from records that already exist — this is the
  // most commercially meaningful measure of a defence advocate, and it is
  // computable exactly because both figures are recorded facts.
  const caseIds = cases.map((c) => c._id);
  const settlements = await Settlement.find({
    legalCase: { $in: caseIds },
    status: { $in: ['executed', 'paid'] },
  })
    .select('totalMinor reserveAtProposalMinor')
    .lean();

  const savingsMinor = settlements.reduce(
    (acc, s) => acc + ((s.reserveAtProposalMinor || 0) - s.totalMinor),
    0
  );
  const avgSettlementMinor = settlements.length
    ? Math.round(settlements.reduce((a, s) => a + s.totalMinor, 0) / settlements.length)
    : 0;

  const feeTotal = feeRows[0]?.totalMinor || 0;

  /**
   * Reporting counsel owes us, of two kinds:
   *   - a live matter whose last progress report is older than the tenant's SLA
   *     (or which has never had one since instructions were accepted);
   *   - a matter counsel has effectively finished but filed no closing report on.
   *
   * This field existed on the schema and was hardcoded to 0, so every advocate
   * looked perfectly compliant and the number was quietly meaningless wherever
   * it was displayed.
   */
  const company = advocate.company;
  const slaDays = company
    ? (await legalConfig.get(company))?.slas?.advocateProgressReport || 30
    : 30;
  const staleBefore = new Date(Date.now() - slaDays * 86400000);

  const [staleReports, missingClosingReports] = await Promise.all([
    LegalCase.countDocuments({
      advocate: advocateId,
      status: { $nin: CLOSED },
      instructionsAcceptedAt: { $ne: null, $lt: staleBefore },
      $or: [
        { lastProgressReportAt: null },
        { lastProgressReportAt: { $exists: false } },
        { lastProgressReportAt: { $lt: staleBefore } },
      ],
    }),
    LegalCase.countDocuments({
      advocate: advocateId,
      status: 'resolution',
      'closingReport.submittedAt': { $exists: false },
    }),
  ]);

  advocate.performance = {
    openMatters,
    closedMatters: closed.length,
    successfulDefences,
    adjudicatedMatters: adjudicated.length,
    settledMatters,
    winRate: adjudicated.length ? successfulDefences / adjudicated.length : 0,
    avgDurationDays,
    avgSettlementMinor,
    savingsMinor,
    overdueActions: overdueEvents,
    outstandingReports: staleReports + missingClosingReports,
    avgFeePerMatterMinor: cases.length ? Math.round(feeTotal / cases.length) : 0,
    recomputedAt: new Date(),
  };

  await advocate.save();
  return advocate.performance;
}

/** Recompute the whole panel. Called nightly by the scheduler. */
async function recomputeAllPerformance() {
  const advocates = await Advocate.find({}).select('_id').lean();
  let done = 0;
  for (const { _id } of advocates) {
    try {
      await recomputePerformance(_id);
      done += 1;
    } catch (err) {
      logger.error(`[advocate] performance recompute failed for ${_id}: ${err.message}`);
    }
  }
  return { advocates: done };
}

// ── Allocation ───────────────────────────────────────────────────────────────

/**
 * Rank the eligible panel for a matter.
 *
 * Scores five factors, each normalised to 0–1 and weighted per tenant:
 *   proximity     — does this advocate cover the court / county?
 *   availability  — inverse of current open matters
 *   winRate       — successful defences over closed matters
 *   savings       — reserve less settled, from the ledger
 *   turnaround    — inverse of average matter duration
 *
 * The cold-start problem is handled explicitly. An advocate newly added to the
 * panel has no closed matters, so a naive score gives them zero on three of the
 * five factors and they would never be instructed — the panel would ossify
 * around whoever happened to be there first. New advocates therefore get a
 * NEUTRAL prior on the history-based factors until they have enough closed
 * matters to judge, and the result says so.
 */
const MIN_MATTERS_FOR_HISTORY = 5;
const NEUTRAL = 0.5;

async function rankPanel({ company, court, county, claimType }) {
  const config = await legalConfig.get(company);
  const weights = config.advocateAllocation?.weights || {};
  const maxOpen = config.advocateAllocation?.maxOpenMattersPerAdvocate || 25;

  const candidates = await Advocate.find({
    company,
    approved: true,
    active: true,
    // An expired retainer is a contractual problem, not a performance one — but
    // instructing on it is still a mistake.
    $or: [{ contractExpiry: null }, { contractExpiry: { $exists: false } }, { contractExpiry: { $gte: new Date() } }],
  }).lean();

  if (!candidates.length) {
    return { mode: 'ranked', candidates: [], reason: 'No approved, active advocates on this panel' };
  }

  // Normalising denominators, computed across the actual candidate set rather
  // than against absolute constants — a panel where everyone carries 30 matters
  // should still rank by relative availability.
  const maxSavings = Math.max(1, ...candidates.map((a) => Math.max(0, a.performance?.savingsMinor || 0)));
  const maxDuration = Math.max(1, ...candidates.map((a) => a.performance?.avgDurationDays || 0));

  const scored = candidates.map((advocate) => {
    const perf = advocate.performance || {};
    const hasHistory = (perf.closedMatters || 0) >= MIN_MATTERS_FOR_HISTORY;

    const covers =
      (court && (advocate.courts || []).includes(court)) ||
      (county && (advocate.counties || []).includes(county));
    const proximity = covers ? 1 : (advocate.courts?.length || advocate.counties?.length) ? 0.3 : NEUTRAL;

    const openMatters = perf.openMatters || 0;
    const availability = Math.max(0, 1 - openMatters / maxOpen);

    const winRate = hasHistory ? perf.winRate || 0 : NEUTRAL;
    const savings = hasHistory ? Math.max(0, perf.savingsMinor || 0) / maxSavings : NEUTRAL;
    const turnaround = hasHistory && perf.avgDurationDays
      ? Math.max(0, 1 - perf.avgDurationDays / maxDuration)
      : NEUTRAL;

    /**
     * Does counsel do what they said, when they said it.
     *
     * Scored against what they are actually carrying rather than an absolute
     * count: two overdue actions across thirty matters is not the same failure
     * as two across three. Applies to everyone, including new advocates — this
     * measures conduct, not track record, so there is nothing to be neutral about.
     */
    const lapses = (perf.overdueActions || 0) + (perf.outstandingReports || 0);
    const load = Math.max(openMatters, 1);
    const reliability = Math.max(0, 1 - lapses / load);

    /**
     * Practice areas against the matter's claim type. Absent a claim type, or
     * where the advocate has declared no areas at all, this cannot discriminate
     * and stays neutral rather than penalising an incomplete profile.
     */
    const areas = (advocate.practiceAreas || []).map((a) => String(a).toLowerCase());
    const specialism = !claimType || areas.length === 0
      ? NEUTRAL
      : areas.some((a) => a === String(claimType).toLowerCase() || a.includes(String(claimType).toLowerCase()))
        ? 1
        : 0.3;

    const factors = { proximity, availability, winRate, savings, turnaround, reliability, specialism };

    /**
     * Normalised by the weights actually applied, so the score stays a 0–1
     * figure whatever a tenant has configured. Without it, dropping a factor to
     * zero silently deflates every score and makes panels incomparable.
     *
     * Unset keys fall back to our default rather than 0 — a tenant configured
     * before a factor existed should still get the benefit of it, while one who
     * deliberately set it to 0 keeps their choice.
     */
    const applied = Object.keys(factors).map((key) => ({
      key,
      weight: weights[key] ?? DEFAULT_ALLOCATION_WEIGHTS[key] ?? 0,
    }));
    const weightTotal = applied.reduce((acc, f) => acc + f.weight, 0);
    const weighted = applied.reduce((acc, f) => acc + factors[f.key] * f.weight, 0);
    const score = weightTotal > 0 ? weighted / weightTotal : 0;

    const reasons = [];
    if (covers) reasons.push(`Covers ${court || county}`);
    if (openMatters >= maxOpen) reasons.push(`At capacity (${openMatters} open)`);
    else if (openMatters === 0) reasons.push('No open matters');
    // Say what the rate is OF — "80% success" over four judgments is a very
    // different claim from the same figure over forty.
    if (hasHistory && perf.adjudicatedMatters > 0 && perf.winRate >= 0.6) {
      reasons.push(
        `${Math.round(perf.winRate * 100)}% success in ${perf.adjudicatedMatters} adjudicated matter(s)`
      );
    }
    if (hasHistory && perf.settledMatters > 0) {
      reasons.push(`${perf.settledMatters} matter(s) settled without judgment`);
    }
    if (hasHistory && perf.savingsMinor > 0) reasons.push(`${money.formatMinor(perf.savingsMinor)} saved against reserve`);
    if (!hasHistory) reasons.push(`New to the panel — scored neutrally on history (${perf.closedMatters || 0} closed)`);
    if (perf.overdueActions > 0) reasons.push(`${perf.overdueActions} overdue action(s)`);
    if (perf.outstandingReports > 0) reasons.push(`${perf.outstandingReports} report(s) outstanding`);
    if (claimType && specialism === 1) reasons.push(`Practises ${String(claimType).replace(/_/g, ' ')}`);

    return {
      advocate: {
        _id: advocate._id,
        name: advocate.name,
        firm: advocate.firm?.name,
        counties: advocate.counties,
        courts: advocate.courts,
      },
      score: Math.round(score * 1000) / 1000,
      factors,
      hasHistory,
      // Over capacity is a warning, not a bar — sometimes the right advocate is
      // the busy one, and the appointer should make that call knowingly.
      atCapacity: openMatters >= maxOpen,
      performance: {
        openMatters,
        closedMatters: perf.closedMatters || 0,
        winRate: perf.winRate || 0,
        adjudicatedMatters: perf.adjudicatedMatters || 0,
        settledMatters: perf.settledMatters || 0,
        savingsMinor: perf.savingsMinor || 0,
        avgDurationDays: perf.avgDurationDays || 0,
        overdueActions: perf.overdueActions || 0,
        outstandingReports: perf.outstandingReports || 0,
      },
      reasons,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return { mode: 'ranked', court, county, claimType, candidates: scored };
}

/**
 * Pick fairly at random from the eligible panel.
 *
 * Requested explicitly, and it is a legitimate policy: rotating work evenly
 * around a panel is a defensible way to run it, and it removes any suggestion
 * that instructions follow relationships. Advocates at capacity are excluded
 * here — unlike ranked mode, there is no human weighing the trade-off.
 */
async function randomFromPanel({ company, court, county }) {
  const { candidates } = await rankPanel({ company, court, county });
  const eligible = candidates.filter((c) => !c.atCapacity);

  if (!eligible.length) {
    throw new ApiError(
      409,
      'No advocate on this panel is both approved and under their matter cap. ' +
      'Raise the cap in legal configuration, or appoint manually.'
    );
  }

  const pick = eligible[Math.floor(Math.random() * eligible.length)];
  return {
    mode: 'random',
    selected: pick,
    pool: eligible.length,
    note: `Selected at random from ${eligible.length} eligible advocate(s)`,
  };
}

/**
 * Suggest an advocate using the tenant's configured mode.
 */
async function suggest({ company, court, county, claimType, mode }) {
  const config = await legalConfig.get(company);
  const effectiveMode = mode || config.advocateAllocation?.mode || 'ranked';

  if (effectiveMode === 'random') return randomFromPanel({ company, court, county });
  if (effectiveMode === 'manual') {
    const { candidates } = await rankPanel({ company, court, county, claimType });
    return { mode: 'manual', candidates, note: 'This insurer appoints manually — ranking shown for reference only' };
  }
  return rankPanel({ company, court, county, claimType });
}

// ── Portal credentials ───────────────────────────────────────────────────────

/**
 * Send one advocate their portal credentials.
 *
 * Two messages, on purpose. The password goes by EMAIL ALONE; the "your access
 * is ready" nudge goes in-app and on WhatsApp, where counsel will actually see
 * it. Sending the password itself over WhatsApp would leave credentials to
 * privileged case files sitting in a chat backup on a phone that may be shared.
 *
 * Shared by panel creation and by a later re-issue so the wording, the channel
 * split and the failure handling stay identical on both paths.
 *
 * @param {Object} advocate      a saved Advocate document
 * @param {string} plainPassword the temporary password, before hashing
 */
async function sendCredentials(advocate, plainPassword) {
  const notify = require('./legalNotify.service');

  const pw = notify.templates.portalAccessEmail({
    name: advocate.name,
    email: advocate.email,
    password: String(plainPassword),
  });
  const notice = notify.templates.portalAccess({ name: advocate.name });

  const [mailed] = await Promise.allSettled([
    notify.send({
      to: { id: advocate._id, type: 'advocate', email: advocate.email, name: advocate.name },
      type: 'legal_portal_access',
      title: pw.title,
      body: pw.body,
      channels: { inApp: false, whatsapp: false, push: false, email: true },
    }),
    notify.sendToAdvocate({
      advocateId: advocate._id,
      type: 'legal_portal_access',
      title: notice.title,
      body: notice.body,
      channels: { email: false },
    }),
  ]);

  // The nudge is a convenience; the email carries the only copy of the password,
  // so its failure is the one worth surfacing to the caller.
  if (mailed.status === 'rejected') {
    throw new ApiError(502, `Portal password email to ${advocate.email} failed: ${mailed.reason?.message}`);
  }

  logger.info(`[advocate] portal credentials sent to ${advocate.email}`);
  return true;
}

/**
 * Issue or re-issue portal access. The advocate signs into partner-fe with the
 * same shell assessors and garages use.
 *
 * Credentials are created automatically when an advocate is added to the panel,
 * so in practice this is the reset path — which is why it does NOT require the
 * advocate to be approved. Approval gates allocation and instruction, not
 * sign-in, and refusing to reset the password of an account that already has
 * access would only strand whoever lost it.
 *
 * Omit `password` to have one generated.
 */
async function issueCredentials(id, password, actor = null) {
  const advocate = await Advocate.findById(id);
  if (!advocate) throw new ApiError(404, 'Advocate not found');

  const plain = password ? String(password) : generateTempPassword();
  if (plain.length < 8) {
    throw new ApiError(400, 'A portal password must be at least 8 characters');
  }

  advocate.password = await bcrypt.hash(plain, 10);
  advocate.active_account = true;
  advocate.mustChangePassword = true;
  // A reset clears a lockout; otherwise the new password is refused for the
  // remainder of the lock window and it reads as though it never arrived.
  advocate.failedLoginAttempts = 0;
  advocate.lockUntil = undefined;
  await advocate.save();

  logger.info(`[advocate] portal access issued to ${advocate.name}`);

  await sendCredentials(advocate, plain);
  return advocate;
}

module.exports = {
  create,
  update,
  setApproval,
  suspend,
  remove,
  list,
  getById,
  recomputePerformance,
  recomputeAllPerformance,
  rankPanel,
  randomFromPanel,
  suggest,
  issueCredentials,
  sendCredentials,
  generateTempPassword,
};
