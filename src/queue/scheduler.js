const { Queue } = require('bullmq');
const { getRedisClient } = require('./connection');
const logger = require('../middlewheres/logger');

/**
 * Time-driven work.
 *
 * Until the Legal module, nothing in AVICS ran on a clock — every background job
 * was enqueued by an HTTP request. Legal cannot work that way: a limitation
 * period expires whether or not anyone opens the app, and a missed filing
 * deadline is not recoverable.
 *
 * BullMQ repeatable jobs give us cluster-safety for free. A repeatable is
 * registered once per schedule in Redis, so however many app instances call
 * registerSchedules() at boot, exactly one job is produced per interval and
 * exactly one worker runs it. That matters because the app runs multi-instance.
 *
 * Every job here must be IDEMPOTENT. A worker can die mid-run and the job will
 * be retried; a reminder that was already sent must not be sent again. The
 * pattern throughout is "record what you did on the document, and skip anything
 * already recorded" — see LegalEvent.remindersSent.
 */

const QUEUE_NAME = 'legal-scheduler';

let schedulerQueue = null;

const getSchedulerQueue = () => {
  const connection = getRedisClient();
  if (!connection) return null;

  if (!schedulerQueue) {
    schedulerQueue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }

  return schedulerQueue;
};

/**
 * The schedules.
 *
 * Cadence is chosen against how fast the underlying state actually changes, not
 * for its own sake: diary reminders are day-granular so hourly is ample, and
 * running the time-bar sweep once daily in the early morning means the alert is
 * waiting when the legal team arrives rather than arriving mid-afternoon.
 *
 * `jobId` pins each repeatable so re-registration on deploy replaces rather than
 * duplicates the schedule.
 */
const SCHEDULES = [
  {
    name: 'diary-reminders',
    // Hourly. Reminder offsets are in days, so this only needs to be fine
    // enough that a reminder lands on the right day, not the right minute.
    pattern: '0 * * * *',
    description: 'Send due reminders for court dates, deadlines and tasks',
  },
  {
    name: 'limitation-sweep',
    // 05:00 daily — the time-bar register is the first thing legal should see.
    pattern: '0 5 * * *',
    description: 'Warn on approaching statutory time-bars and mark expired ones',
  },
  {
    name: 'overdue-escalation',
    // 07:00 daily. Escalation moves a rung at a time up the tenant's chain.
    pattern: '0 7 * * *',
    description: 'Mark missed events and escalate them up the tenant escalation chain',
  },
  {
    name: 'advocate-report-chaser',
    // Weekly, Monday 08:00.
    pattern: '0 8 * * 1',
    description: 'Chase advocates whose progress reports are outstanding',
  },
  {
    name: 'advocate-performance-recompute',
    // Nightly. Feeds the allocation engine, so it only needs to be fresh daily.
    pattern: '30 2 * * *',
    description: 'Recompute panel advocate performance from cases and the ledger',
  },
  {
    name: 'referral-sweep',
    // 06:00 daily, an hour before the escalation sweep — a claim auto-referred
    // this morning should be in the queue the legal team opens at the start of
    // the day, not arrive after they have already triaged it.
    pattern: '0 6 * * *',
    description: 'Evaluate open claims against the tenant referral triggers',
  },
  {
    name: 'audit-seal',
    // Every 15 minutes: tighter sealing narrows the window in which a tampered
    // row is not yet covered by a seal.
    pattern: '*/15 * * * *',
    description: 'Seal new audit rows into the tamper-evident chain',
  },
];

/**
 * Register every repeatable schedule. Safe to call from every instance at boot —
 * BullMQ deduplicates on jobId.
 *
 * @returns {Promise<number>} number of schedules registered
 */
async function registerSchedules() {
  const queue = getSchedulerQueue();
  if (!queue) {
    logger.warn('[scheduler] REDIS_URL not set — legal schedules not registered');
    return 0;
  }

  let registered = 0;
  for (const schedule of SCHEDULES) {
    try {
      await queue.add(
        schedule.name,
        { scheduledJob: schedule.name },
        {
          repeat: { pattern: schedule.pattern },
          jobId: `legal:${schedule.name}`,
        }
      );
      registered += 1;
    } catch (err) {
      logger.error(`[scheduler] failed to register ${schedule.name}: ${err.message}`);
    }
  }

  logger.info(`[scheduler] registered ${registered}/${SCHEDULES.length} legal schedules`);
  return registered;
}

/**
 * Remove every registered repeatable. Used when disabling the module for an
 * environment, and by tests.
 */
async function clearSchedules() {
  const queue = getSchedulerQueue();
  if (!queue) return 0;

  const repeatables = await queue.getRepeatableJobs();
  let removed = 0;
  for (const job of repeatables) {
    await queue.removeRepeatableByKey(job.key);
    removed += 1;
  }
  logger.info(`[scheduler] cleared ${removed} repeatable jobs`);
  return removed;
}

/**
 * Enqueue a schedule immediately, outside its normal cadence — for operational
 * use ("run the time-bar sweep now") and for tests.
 */
async function runNow(name) {
  const queue = getSchedulerQueue();
  if (!queue) throw new Error('Scheduler queue unavailable — REDIS_URL not set');
  if (!SCHEDULES.some((s) => s.name === name)) {
    throw new Error(`Unknown schedule: ${name}`);
  }
  return queue.add(name, { scheduledJob: name, manual: true });
}

module.exports = {
  QUEUE_NAME,
  SCHEDULES,
  getSchedulerQueue,
  registerSchedules,
  clearSchedules,
  runNow,
};
