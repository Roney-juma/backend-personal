const logger = require('../middlewheres/logger');
const auditSeal = require('../service/auditSeal.service');

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
 * Phase 0 wires the scheduler, the audit sealer and the job skeletons. The
 * reminder, escalation and performance handlers are filled in with their
 * features in Phases 1 and 3 — they are registered now, and no-op with a clear
 * log line, so the schedule itself is proven in staging before anything depends
 * on it.
 */

/**
 * Send reminders for court dates, filing deadlines and tasks falling due.
 * Filled in with the diary — Phase 1 (limitation) and Phase 3 (court diary).
 */
async function diaryReminders() {
  logger.info('[legal-jobs] diary-reminders: not yet implemented (Phase 1)');
  return { sent: 0, implemented: false };
}

/**
 * Warn on approaching statutory time-bars and mark expired ones.
 * The single most consequential job in the module — Phase 1.
 */
async function limitationSweep() {
  logger.info('[legal-jobs] limitation-sweep: not yet implemented (Phase 1)');
  return { warned: 0, expired: 0, implemented: false };
}

/**
 * Mark events that passed their due date as missed and walk them up the
 * tenant's escalation chain — Phase 1.
 */
async function overdueEscalation() {
  logger.info('[legal-jobs] overdue-escalation: not yet implemented (Phase 1)');
  return { missed: 0, escalated: 0, implemented: false };
}

/**
 * Chase panel advocates whose progress reports are outstanding — Phase 3.
 */
async function advocateReportChaser() {
  logger.info('[legal-jobs] advocate-report-chaser: not yet implemented (Phase 3)');
  return { chased: 0, implemented: false };
}

/**
 * Recompute panel advocate performance from cases and the ledger, feeding the
 * allocation engine — Phase 3.
 */
async function advocatePerformanceRecompute() {
  logger.info('[legal-jobs] advocate-performance-recompute: not yet implemented (Phase 3)');
  return { advocates: 0, implemented: false };
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
