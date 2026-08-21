const logger = require('../middlewheres/logger');
const auditSeal = require('../service/auditSeal.service');
const legalReminder = require('../service/legalReminder.service');

/**
 * Handlers for the Legal module's scheduled jobs.
 *
 * Registered as a BullMQ worker in src/worker.js and driven by the repeatables
 * in queue/scheduler.js.
 *
 * EVERY handler here must be idempotent. A worker can die mid-run, a job is
 * retried three times, and two deploys can briefly overlap — so "did I already
 * do this?" has to be answerable from the data, not from the job. The pattern is
 * to record the work on the document (LegalEvent.remindersSent, AuditSeal
 * ranges) and skip anything already recorded, never to rely on the job running
 * exactly once.
 *
 * Phase 1 implements the diary, limitation and escalation sweeps. The advocate
 * handlers stay stubbed until the panel and portal land in Phase 3 — they are
 * registered now, and no-op with a clear log line, so the schedule itself is
 * proven in staging before anything depends on it.
 */

/**
 * Send reminders for court dates, filing deadlines and tasks falling due.
 *
 * Idempotent through LegalEvent.remindersSent — an offset already recorded is
 * never sent twice, however many times this is retried.
 */
async function diaryReminders() {
  return { ...(await legalReminder.runDiaryReminders()), implemented: true };
}

/**
 * Warn on approaching statutory time-bars and mark expired ones.
 *
 * The most consequential job in the module: after the date passes the claim can
 * no longer be brought, and a defence we failed to file is lost by default.
 */
async function limitationSweep() {
  return { ...(await legalReminder.runLimitationSweep()), implemented: true };
}

/**
 * Mark events that passed their due date as missed and walk them up the
 * tenant's configured escalation chain.
 */
async function overdueEscalation() {
  return { ...(await legalReminder.runOverdueEscalation()), implemented: true };
}

/**
 * Chase panel advocates whose progress reports are overdue.
 *
 * An advocate who has gone quiet on a live matter is the commonest way an
 * insurer discovers a problem late. The SLA is per-tenant.
 */
async function advocateReportChaser() {
  const LegalCase = require('../models/legalCase.model');
  const legalConfig = require('../service/legalConfig.service');
  const notify = require('../service/legalNotify.service');

  const cases = await LegalCase.find({
    status: { $in: ['counsel_appointed', 'pre_litigation', 'litigation', 'settlement', 'appeal'] },
    advocate: { $ne: null },
    instructionsIssuedAt: { $ne: null },
  })
    .populate('advocate', 'name email company')
    .limit(1000)
    .lean();

  let chased = 0;

  for (const legalCase of cases) {
    try {
      const config = await legalConfig.get(legalCase.company);
      const slaDays = config.slas?.advocateProgressReport || 30;

      const since = legalCase.lastProgressReportAt || legalCase.instructionsIssuedAt;
      const daysSince = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
      if (daysSince < slaDays) continue;

      // Chase the advocate on every channel — counsel is rarely sitting in the
      // portal, so an in-app nudge alone is the one that gets missed.
      if (legalCase.advocate?._id) {
        const msg = notify.templates.progressReportOverdue({
          caseNumber: legalCase.caseNumber,
          courtCase: legalCase.courtCaseNumber,
          days: daysSince,
          court: legalCase.court,
        });
        await notify
          .sendToAdvocate({
            advocateId: legalCase.advocate._id,
            type: 'legal_progress_report_due',
            title: msg.title,
            body: msg.body,
            claimId: legalCase.claim,
          })
          .catch((err) => logger.warn(`[legal-jobs] advocate chase failed: ${err.message}`));
      }
      chased += 1;
    } catch (err) {
      logger.error(`[legal-jobs] chaser failed on ${legalCase.caseNumber}: ${err.message}`);
    }
  }

  return { chased, scanned: cases.length, implemented: true };
}

/**
 * Recompute panel advocate performance from cases, settlements and the ledger.
 *
 * Feeds the allocation engine, so it only needs to be a day fresh — but it must
 * never be stale in a way that advantages an advocate in ranking.
 */
async function advocatePerformanceRecompute() {
  const advocateService = require('../service/advocate.service');
  const result = await advocateService.recomputeAllPerformance();
  return { ...result, implemented: true };
}

/**
 * Evaluate open claims against each tenant's configured referral triggers.
 *
 * Only triggers the tenant marked `autoRefer` create a referral; the rest are
 * advisory and surface as flags. A claim already referred is skipped —
 * re-referring something Legal is already handling is the fastest way to make
 * people ignore the queue.
 */
async function referralSweep() {
  const InsuranceCompany = require('../models/insuranceCompany.model');
  const referralService = require('../service/legalReferral.service');

  const companies = await InsuranceCompany.find({}).select('_id').lean();
  let evaluated = 0;
  let referred = 0;

  for (const c of companies) {
    try {
      const r = await referralService.sweep({ company: c._id });
      evaluated += r.evaluated;
      referred += r.referred;
    } catch (err) {
      logger.error(`[legal-jobs] referral sweep failed for company ${c._id}: ${err.message}`);
    }
  }

  return { evaluated, referred, implemented: true };
}

/**
 * Seal newly written audit rows into the tamper-evident chain.
 *
 * Live from Phase 0: the chain is only meaningful if sealing has been running
 * since the first row, so this cannot wait for a later phase.
 */
async function auditSealJob() {
  const result = await auditSeal.sealPending();
  return { ...result, implemented: true };
}

const HANDLERS = {
  'diary-reminders': diaryReminders,
  'limitation-sweep': limitationSweep,
  'overdue-escalation': overdueEscalation,
  'advocate-report-chaser': advocateReportChaser,
  'advocate-performance-recompute': advocatePerformanceRecompute,
  'referral-sweep': referralSweep,
  'audit-seal': auditSealJob,
};

/**
 * BullMQ processor for the legal-scheduler queue.
 *
 * @param {import('bullmq').Job} job
 */
async function process(job) {
  const handler = HANDLERS[job.name];
  if (!handler) {
    // Unknown job names are almost always a stale repeatable left behind by an
    // older deploy. Log and succeed rather than retrying forever.
    logger.warn(`[legal-jobs] no handler for '${job.name}' — ignoring (stale schedule?)`);
    return { ignored: true };
  }

  const started = Date.now();
  const result = await handler(job);
  const ms = Date.now() - started;

  if (result?.implemented !== false) {
    logger.info(`[legal-jobs] ${job.name} finished in ${ms}ms — ${JSON.stringify(result)}`);
  }
  return result;
}

module.exports = { process, HANDLERS };
