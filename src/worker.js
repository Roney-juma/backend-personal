require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Worker } = require('bullmq');
const { getRedisClient } = require('./queue/connection');
const { sendEmailDirect, verifyTransport } = require('./service/email.service');
const { sendWhatsAppDirect } = require('./service/whatsapp.service');
const { sendPushDirect } = require('./service/firebase.service');
const { runWithContext } = require('./utils/requestContext');
const logger = require('./middlewheres/logger');

// Mongoose must be connected for the pipeline's DB queries
const mongoose = require('mongoose');
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL, {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL) || 20,
    minPoolSize: Number(process.env.MONGO_MIN_POOL) || 5,
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000,
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
    retryWrites: true,
    w: 'majority',
  }).catch(err =>
    logger.error(`Worker MongoDB connect failed: ${err.message}`)
  );
}

const connection = getRedisClient();

if (!connection) {
  logger.error('REDIS_URL is not set — worker cannot start');
  process.exit(1);
}

// Expose the worker's Node runtime metrics (event-loop lag, heap, GC, CPU) on its
// own loopback port (9470), separate from the web app's 9464/9465 so ports never
// collide. Scraped by Prometheus as the 'ave-worker' job.
const { startMetricsServer } = require('./metrics');
startMetricsServer(9470);

// ── Notification worker ───────────────────────────────────────────────────────

// Run each job inside the originating request's correlation context so all downstream
// worker logs carry the same trace id as the HTTP request that enqueued it.
const notificationProcessor = (job) => runWithContext({ correlationId: job.data.correlationId }, async () => {
  switch (job.name) {
    case 'email': {
      const { to, subject, text } = job.data;
      if (!to || !subject) throw new Error(`Invalid email job data: ${JSON.stringify(job.data)}`);
      await sendEmailDirect(to, subject, text);
      break;
    }
    case 'whatsapp': {
      const { to, message, template } = job.data;
      if (!to || !message) throw new Error(`Invalid WhatsApp job data: ${JSON.stringify(job.data)}`);
      await sendWhatsAppDirect(to, message, template);
      break;
    }
    case 'push': {
      const { recipientId, recipientType } = job.data;
      if (!recipientId || !recipientType) throw new Error(`Invalid push job data: ${JSON.stringify(job.data)}`);
      await sendPushDirect(job.data);
      break;
    }
    default:
      logger.warn(`Unknown notification job type: ${job.name}`);
  }
});

const worker = new Worker('ave-notifications', notificationProcessor, {
  connection,
  concurrency: 10,
  limiter: { max: 50, duration: 1000 },
});

// Confirm the worker is up and that SMTP is actually reachable — the two things
// that silently break queued email delivery when misconfigured.
logger.info('[worker] notification worker started — listening on ave-notifications');
verifyTransport();

// ── Fraud analysis worker ─────────────────────────────────────────────────────

const pipeline = require('./ai/pipeline');
const continuityPipeline = require('./ai/continuityPipeline');

const analyzeWorker = new Worker('claim-analyze', (job) => runWithContext({ correlationId: job.data.correlationId }, async () => {
  const { claimId, stage } = job.data;
  if (!claimId) throw new Error(`Invalid claim-analyze job: missing claimId`);
  if (stage) {
    // Cross-stage vehicle-continuity check (assessment / garage / re-assessment).
    logger.info(`[continuity] starting ${stage} check for claim ${claimId}`);
    await continuityPipeline.runStageCheck(claimId, stage);
    return;
  }
  logger.info(`[pipeline] starting analysis for claim ${claimId}`);
  await pipeline.run(claimId);
}), {
  connection,
  concurrency: 5, // analysis is heavier than notifications
});

// ── Event listeners ───────────────────────────────────────────────────────────

worker.on('completed', (job) => {
  logger.info(`Job completed | queue=notifications | id=${job.id} | type=${job.name} | cid=${job.data?.correlationId}`);
});
worker.on('failed', (job, err) => {
  logger.error(`Job failed | queue=notifications | id=${job?.id} | type=${job?.name} | attempt=${job?.attemptsMade} | cid=${job?.data?.correlationId} | error=${err.message}`);
});
worker.on('error', (err) => {
  logger.error(`Notification worker error: ${err.message}`);
});

analyzeWorker.on('completed', (job) => {
  logger.info(`Job completed | queue=claim-analyze | id=${job.id} | claimId=${job.data?.claimId} | cid=${job.data?.correlationId}`);
});
analyzeWorker.on('failed', (job, err) => {
  logger.error(`Job failed | queue=claim-analyze | id=${job?.id} | claimId=${job?.data?.claimId} | attempt=${job?.attemptsMade} | cid=${job?.data?.correlationId} | error=${err.message}`);
});
analyzeWorker.on('error', (err) => {
  logger.error(`Analyze worker error: ${err.message}`);
});

logger.info('Workers started — ave-notifications + claim-analyze');

process.on('SIGTERM', async () => {
  await Promise.all([worker.close(), analyzeWorker.close()]);
  logger.info('Workers shut down gracefully');
  process.exit(0);
});
