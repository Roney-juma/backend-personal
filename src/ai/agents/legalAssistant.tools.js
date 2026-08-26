/**
 * Read-only tools for the AI legal assistant.
 *
 * Three rules run through every tool here, and they are stricter than the
 * front-office assistant's:
 *
 *   1. READ-ONLY. The assistant can look at anything a legal officer can look
 *      at, and change nothing. Spec §19 is explicit that it must not approve
 *      settlements or issue binding advice, and the cheapest way to guarantee
 *      that is to give it no tool that writes.
 *
 *   2. TENANT-SCOPED. Every query filters on the caller's company. An assistant
 *      that can be talked into reading another insurer's litigation is a far
 *      worse problem than one that occasionally answers "I don't know".
 *
 *   3. NO PRIVILEGED CONTENT. Document tools return metadata — title, type,
 *      version, whether it exists — never the text of a privileged document.
 *      Model context is not a place privileged material should end up.
 *
 * Results are compact and capped: the assistant reasons better over twenty tight
 * rows than over two hundred fat ones, and it costs less.
 */

const mongoose = require('mongoose');
const ThirdPartyClaim = require('../../models/thirdPartyClaim.model');
const LegalCase = require('../../models/legalCase.model');
const LegalEvent = require('../../models/legalEvent.model');
const LegalDocument = require('../../models/legalDocument.model');
const Settlement = require('../../models/settlement.model');
const Recovery = require('../../models/recovery.model');
const Claim = require('../../models/claim.model');
const money = require('../../utils/money');
const legalLedger = require('../../service/legalLedger.service');
const legalAnalytics = require('../../service/legalAnalytics.service');
const limitation = require('../../service/limitation.service');

const CAP = 25;

// ── compact mappers ──────────────────────────────────────────────────────────

const ksh = (minor) => (minor === null || minor === undefined ? null : money.formatMinor(minor));

const tpcRow = (c) => ({
  ref: c.referenceNumber,
  claimant: c.party?.name,
  type: c.claimType,
  status: c.status,
  exposure: ksh(c.exposure?.cappedMinor),
  reserve: ksh(c.reserve?.currentMinor),
  liabilityShare: c.liability?.insuredSharePercent ?? null,
  disputed: c.liability?.disputed || false,
  daysToTimeBar: limitation.daysRemaining(c),
});

const caseRow = (c) => ({
  caseNumber: c.caseNumber,
  courtCase: c.courtCaseNumber,
  court: c.court,
  status: c.status,
  advocate: c.advocate?.name,
  filedAt: c.filedAt,
  nextAction: c.nextActionLabel,
  nextActionAt: c.nextActionAt,
});

const eventRow = (e) => ({
  title: e.title,
  type: e.eventType,
  kind: e.kind,
  dueAt: e.dueAt,
  status: e.status,
  daysUntil: Math.ceil((new Date(e.dueAt).getTime() - Date.now()) / 86400000),
});

// ── tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'find_third_party_claims',
    description:
      'Search third-party claims (people claiming against an insured). Use for questions about who is ' +
      'claiming, exposure, reserves, or time-bars. Returns compact rows, newest or soonest-expiring first.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'e.g. notified, demand_received, negotiation, settled, litigated' },
        claimType: { type: 'string', description: 'bodily_injury | fatal | property_damage | loss_of_use | medical_expenses' },
        search: { type: 'string', description: 'Reference number, claimant name or ID number' },
        timeBarWithinDays: { type: 'number', description: 'Only claims whose limitation expires within N days' },
        claimId: { type: 'string', description: 'All third-party claims on one accident' },
      },
    },
  },
  {
    name: 'get_third_party_claim',
    description:
      'Full detail for one third-party claim by its reference (e.g. TPC-2026-00412): party, injury, ' +
      'liability apportionment, quantum breakdown, exposure, reserve and limitation.',
    input_schema: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
  },
  {
    name: 'find_legal_cases',
    description:
      'Search matters that have reached court. Use for questions about suits, courts, advocates or ' +
      'what is happening next on a case.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        court: { type: 'string' },
        advocateName: { type: 'string' },
        caseNumber: { type: 'string', description: 'LEG-… or the court case number' },
      },
    },
  },
  {
    name: 'get_case_chronology',
    description:
      'Build a dated chronology of one matter from the records already held — accident, registration, ' +
      'assessments, offers, court events, judgment. Use when asked what happened and when, or for a ' +
      'case summary. Returns events in date order.',
    input_schema: {
      type: 'object',
      properties: { caseNumber: { type: 'string' }, reference: { type: 'string', description: 'Or a TPC reference' } },
    },
  },
  {
    name: 'get_diary',
    description:
      'Upcoming and overdue diary entries — court dates, filing deadlines and statutory time-bars. ' +
      'Use for questions about what is due, what is late, or what is coming up.',
    input_schema: {
      type: 'object',
      properties: {
        withinDays: { type: 'number', description: 'Defaults to 30' },
        overdueOnly: { type: 'boolean' },
        kind: { type: 'string', description: 'court_event | deadline | limitation | task' },
      },
    },
  },
  {
    name: 'list_case_documents',
    description:
      'List the documents on a matter — titles, types, versions and whether each is privileged. ' +
      'Returns METADATA ONLY, never document contents. Use to answer what is on the file and, by ' +
      'comparison against what a matter of this type needs, what is missing.',
    input_schema: {
      type: 'object',
      properties: { caseNumber: { type: 'string' }, reference: { type: 'string' } },
    },
  },
  {
    name: 'get_financial_position',
    description:
      'The money on a matter or across the book: reserves, settlement, costs, recoveries and net ' +
      'exposure, from the legal ledger. Use for any question about what something has cost or is ' +
      'reserved at.',
    input_schema: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'TPC reference — omit for the whole book' },
        caseNumber: { type: 'string' },
      },
    },
  },
  {
    name: 'compare_demand_to_reserve',
    description:
      'Compare what a claimant has demanded against our assessed exposure and what is reserved. Use ' +
      'when asked whether a demand is reasonable, or where the gap sits.',
    input_schema: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
  },
  {
    name: 'find_similar_settled_claims',
    description:
      'Find comparable claims already settled — same injury type and a similar liability split — and ' +
      'what they settled at. Use when asked what a claim might be worth. Always report the number of ' +
      'comparables so the user can judge the weight.',
    input_schema: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
  },
  {
    name: 'get_recoveries',
    description:
      'Subrogation — what we are recovering from third parties, how much is outstanding and what has ' +
      'gone quiet. Use for questions about recoveries or money coming back in.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        staleOnly: { type: 'boolean', description: 'Only recoveries not chased recently' },
      },
    },
  },
];

// ── execution ────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {Object} input
 * @param {Object} ctx  { company } — the caller's tenant. Never taken from the model.
 */
async function executeTool(name, input, ctx) {
  const { company } = ctx;
  if (!company) return { error: 'No insurer is associated with this session.' };
  const scoped = { company: new mongoose.Types.ObjectId(String(company)) };

  switch (name) {
    case 'find_third_party_claims': {
      const filter = { ...scoped };
      if (input.status) filter.status = input.status;
      if (input.claimType) filter.claimType = input.claimType;
      if (input.claimId && mongoose.isValidObjectId(input.claimId)) filter.claim = input.claimId;
      if (input.timeBarWithinDays) {
        filter['limitation.expiresAt'] = {
          $lte: new Date(Date.now() + Number(input.timeBarWithinDays) * 86400000),
        };
      }
      if (input.search) {
        const rx = new RegExp(String(input.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ referenceNumber: rx }, { 'party.name': rx }, { 'party.idNumber': rx }];
      }

      const rows = await ThirdPartyClaim.find(filter)
        .sort({ 'limitation.expiresAt': 1 })
        .limit(CAP)
        .lean();
      return { count: rows.length, capped: rows.length === CAP, claims: rows.map(tpcRow) };
    }

    case 'get_third_party_claim': {
      const c = await ThirdPartyClaim.findOne({ ...scoped, referenceNumber: input.reference }).lean();
      if (!c) return { error: `No third-party claim with reference ${input.reference}` };
      return {
        ...tpcRow(c),
        party: c.party,
        injury: c.injury,
        opposingAdvocate: c.opposingAdvocate,
        liability: c.liability,
        quantum: {
          demanded: ksh(c.quantum?.demandedMinor),
          ourAssessment: ksh(c.quantum?.ourAssessmentMinor),
          generalDamages: ksh(c.quantum?.generalDamagesMinor),
          specialDamages: ksh(c.quantum?.specialDamagesMinor),
          lossOfEarnings: ksh(c.quantum?.lossOfEarningsMinor),
          basis: c.quantum?.basis,
        },
        exposure: {
          gross: ksh(c.exposure?.grossMinor),
          afterApportionment: ksh(c.exposure?.afterApportionmentMinor),
          capped: ksh(c.exposure?.cappedMinor),
          limitApplied: c.exposure?.limitApplied,
          excessOfLimit: ksh(c.exposure?.excessOfLimitMinor),
        },
        limitation: c.limitation,
        riskLevel: c.riskLevel,
      };
    }

    case 'find_legal_cases': {
      const filter = { ...scoped };
      if (input.status) filter.status = input.status;
      if (input.court) filter.court = new RegExp(String(input.court), 'i');
      if (input.caseNumber) {
        filter.$or = [
          { caseNumber: new RegExp(String(input.caseNumber), 'i') },
          { courtCaseNumber: new RegExp(String(input.caseNumber), 'i') },
        ];
      }

      let cases = await LegalCase.find(filter)
        .sort({ nextActionAt: 1 })
        .limit(CAP)
        .populate('advocate', 'name')
        .lean();

      if (input.advocateName) {
        const rx = new RegExp(String(input.advocateName), 'i');
        cases = cases.filter((c) => rx.test(c.advocate?.name || ''));
      }
      return { count: cases.length, cases: cases.map(caseRow) };
    }

    case 'get_case_chronology': {
      const legalCase = input.caseNumber
        ? await LegalCase.findOne({
            ...scoped,
            $or: [{ caseNumber: input.caseNumber }, { courtCaseNumber: input.caseNumber }],
          }).lean()
        : null;

      const tpc = input.reference
        ? await ThirdPartyClaim.findOne({ ...scoped, referenceNumber: input.reference }).lean()
        : legalCase
          ? await ThirdPartyClaim.findOne({ ...scoped, legalCase: legalCase._id }).lean()
          : null;

      if (!legalCase && !tpc) return { error: 'No matter found for that reference' };

      const claimId = legalCase?.claim || tpc?.claim;
      const [claim, events, settlements] = await Promise.all([
        Claim.findById(claimId).select('incidentDetails createdAt source').lean(),
        LegalEvent.find({
          ...(legalCase ? { legalCase: legalCase._id } : { thirdPartyClaim: tpc._id }),
        })
          .sort({ dueAt: 1 })
          .limit(50)
          .lean(),
        Settlement.find({ ...(tpc ? { thirdPartyClaim: tpc._id } : { legalCase: legalCase._id }) })
          .select('reference proposedAt approvedAt executedAt paidAt totalMinor status')
          .lean(),
      ]);

      // Everything the system already knows, in date order — the assistant does
      // not invent dates, it arranges recorded ones.
      const entries = [];
      const add = (date, what) => date && entries.push({ date: new Date(date), what });

      add(claim?.incidentDetails?.date, 'Accident occurred');
      add(claim?.createdAt, claim?.source === 'third_party_notification'
        ? 'Claim opened from a third-party notification'
        : 'Claim reported by the insured');
      add(tpc?.firstNotifiedAt, `Third-party claim registered — ${tpc?.party?.name}`);
      add(tpc?.demandReceivedAt, 'Demand received');
      add(tpc?.liability?.assessedAt, `Liability assessed — insured ${tpc?.liability?.insuredSharePercent}%`);
      add(tpc?.quantum?.assessedAt, 'Quantum assessed');
      add(legalCase?.filedAt, `Suit filed — ${legalCase?.courtCaseNumber || ''} in ${legalCase?.court || 'court'}`);
      add(legalCase?.appointedAt, 'Advocate appointed');
      add(legalCase?.instructionsIssuedAt, 'Instructions issued to counsel');
      for (const s of settlements) {
        add(s.proposedAt, `Settlement ${s.reference} proposed at ${ksh(s.totalMinor)}`);
        add(s.approvedAt, `Settlement ${s.reference} approved`);
        add(s.executedAt, `Settlement ${s.reference} executed`);
        add(s.paidAt, `Settlement ${s.reference} paid`);
      }
      for (const e of events) {
        if (e.status === 'done' || new Date(e.dueAt) < new Date()) {
          add(e.dueAt, `${e.title}${e.outcome ? ` — ${e.outcome}` : ''}`);
        }
      }
      add(legalCase?.judgment?.deliveredAt, `Judgment: ${legalCase?.judgment?.liabilityOutcome}`);
      add(tpc?.limitation?.expiresAt, 'Statutory limitation expires');

      entries.sort((a, b) => a.date - b.date);
      return {
        matter: legalCase?.caseNumber || tpc?.referenceNumber,
        chronology: entries.map((e) => ({ date: e.date.toISOString().slice(0, 10), event: e.what })),
      };
    }

    case 'get_diary': {
      const filter = { ...scoped };
      if (input.kind) filter.kind = input.kind;

      if (input.overdueOnly) {
        filter.status = { $in: ['scheduled', 'pending', 'missed'] };
        filter.dueAt = { $lt: new Date() };
      } else {
        filter.status = { $in: ['scheduled', 'pending'] };
        filter.dueAt = {
          $gte: new Date(),
          $lte: new Date(Date.now() + (Number(input.withinDays) || 30) * 86400000),
        };
      }

      const events = await LegalEvent.find(filter)
        .sort({ dueAt: 1 })
        .limit(CAP)
        .populate('legalCase', 'caseNumber courtCaseNumber')
        .lean();

      return {
        count: events.length,
        events: events.map((e) => ({
          ...eventRow(e),
          case: e.legalCase?.courtCaseNumber || e.legalCase?.caseNumber,
        })),
      };
    }

    case 'list_case_documents': {
      const legalCase = input.caseNumber
        ? await LegalCase.findOne({
            ...scoped,
            $or: [{ caseNumber: input.caseNumber }, { courtCaseNumber: input.caseNumber }],
          }).lean()
        : null;
      const tpc = input.reference
        ? await ThirdPartyClaim.findOne({ ...scoped, referenceNumber: input.reference }).lean()
        : null;

      if (!legalCase && !tpc) return { error: 'No matter found for that reference' };

      const docs = await LegalDocument.find({
        ...scoped,
        isCurrent: true,
        ...(legalCase ? { legalCase: legalCase._id } : { thirdPartyClaim: tpc._id }),
      })
        .select('title docType version confidentiality filedAt createdAt')
        .lean();

      return {
        count: docs.length,
        // Metadata only. The contents of a privileged document must never enter
        // model context, and the safest way to ensure that is not to fetch them.
        documents: docs.map((d) => ({
          title: d.title,
          type: d.docType,
          version: d.version,
          privileged: d.confidentiality === 'privileged',
          filed: Boolean(d.filedAt),
        })),
        note: 'Metadata only — document contents are not available to this assistant.',
      };
    }

    case 'get_financial_position': {
      let scopeArg = { company };
      if (input.reference) {
        const tpc = await ThirdPartyClaim.findOne({ ...scoped, referenceNumber: input.reference })
          .select('_id')
          .lean();
        if (!tpc) return { error: `No third-party claim with reference ${input.reference}` };
        scopeArg = { thirdPartyClaim: tpc._id };
      } else if (input.caseNumber) {
        const lc = await LegalCase.findOne({ ...scoped, caseNumber: input.caseNumber }).select('_id').lean();
        if (!lc) return { error: `No case ${input.caseNumber}` };
        scopeArg = { legalCase: lc._id };
      }

      const p = await legalLedger.position(scopeArg);
      return {
        netExposure: ksh(p.netExposureMinor),
        reserveTotal: ksh(p.reserveTotalMinor),
        settlementAndJudgment: ksh(p.settlementAndJudgmentMinor),
        legalCosts: ksh(p.legalCostsMinor),
        courtCosts: ksh(p.courtCostsMinor),
        expertCosts: ksh(p.expertCostsMinor),
        interest: ksh(p.interestMinor),
        recoveries: ksh(p.recoveriesMinor),
        paidToDate: ksh(p.paidToDateMinor),
      };
    }

    case 'compare_demand_to_reserve': {
      const c = await ThirdPartyClaim.findOne({ ...scoped, referenceNumber: input.reference }).lean();
      if (!c) return { error: `No third-party claim with reference ${input.reference}` };

      const demanded = c.quantum?.demandedMinor || 0;
      const exposure = c.exposure?.cappedMinor || 0;
      const reserve = c.reserve?.currentMinor || 0;

      return {
        reference: c.referenceNumber,
        demanded: ksh(demanded),
        ourExposure: ksh(exposure),
        reserved: ksh(reserve),
        demandVsExposure: demanded && exposure ? ksh(demanded - exposure) : null,
        exposureVsReserve: ksh(exposure - reserve),
        liabilityShare: c.liability?.insuredSharePercent ?? null,
        liabilityAssessed: c.exposure?.liabilityAssessed ?? false,
        limitApplied: c.exposure?.limitApplied || false,
      };
    }

    case 'find_similar_settled_claims': {
      const c = await ThirdPartyClaim.findOne({ ...scoped, referenceNumber: input.reference })
        .select('_id')
        .lean();
      if (!c) return { error: `No third-party claim with reference ${input.reference}` };

      const result = await legalAnalytics.similarMatters(c._id, { limit: 10 });
      return {
        basis: result.basis,
        liabilityWindow: result.liabilityWindow,
        count: result.count,
        medianSettled: ksh(result.medianSettledMinor),
        range: result.rangeMinor
          ? { min: ksh(result.rangeMinor.min), max: ksh(result.rangeMinor.max) }
          : null,
        reliable: result.reliable,
        // Carried through verbatim so the assistant repeats the caveat rather
        // than presenting a median from three matters as a valuation.
        note: result.note,
      };
    }

    case 'get_recoveries': {
      if (input.staleOnly) {
        const recoveryService = require('../../service/recovery.service');
        const stale = await recoveryService.stale({ company });
        return {
          count: stale.length,
          recoveries: stale.slice(0, CAP).map((r) => ({
            ref: r.reference,
            from: r.recoverFrom?.name,
            recoverable: ksh(r.recoverableMinor),
            outstanding: ksh(r.outstandingMinor),
            quietDays: r.quietDays,
            status: r.status,
          })),
        };
      }

      const filter = { ...scoped };
      if (input.status) filter.status = input.status;
      const rows = await Recovery.find(filter).sort({ identifiedAt: 1 }).limit(CAP).lean();
      return {
        count: rows.length,
        recoveries: rows.map((r) => ({
          ref: r.reference,
          from: r.recoverFrom?.name,
          basis: r.basis,
          recoverable: ksh(r.recoverableMinor),
          recovered: ksh(r.recoveredMinor),
          status: r.status,
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOLS, executeTool };
