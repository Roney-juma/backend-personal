require('dotenv').config();
const { Worker } = require('bullmq');
const { getRedisClient } = require('./queue/connection');
const { sendEmailDirect } = require('./service/email.service');
const { sendWhatsAppDirect } = require('./service/whatsapp.service');
const logger = require('./middlewheres/logger');

const connection = getRedisClient();

if (!connection) {
  logger.error('REDIS_URL is not set — worker cannot start');
  process.exit(1);
}

const processor = async (job) => {
  switch (job.name) {
    case 'email': {
      const { to, subject, text } = job.data;
      if (!to || !subject) throw new Error(`Invalid email job data: ${JSON.stringify(job.data)}`);
      await sendEmailDirect(to, subject, text);
      break;
    }
    case 'whatsapp': {
      const { to, message } = job.data;
      if (!to || !message) throw new Error(`Invalid WhatsApp job data: ${JSON.stringify(job.data)}`);
      await sendWhatsAppDirect(to, message);
      break;
    }
    default:
      logger.warn(`Unknown job type: ${job.name}`);
  }
};

const worker = new Worker('ave-notifications', processor, {
  connection,
  concurrency: 10,
  limiter: {
    max: 50,
    duration: 1000,
  },
});

worker.on('completed', (job) => {
  logger.info(`Job completed | id=${job.id} | type=${job.name}`);
});

worker.on('failed', (job, err) => {
  logger.error(`Job failed | id=${job?.id} | type=${job?.name} | attempt=${job?.attemptsMade} | error=${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Worker error: ${err.message}`);
});

logger.info('Notification worker started — listening on ave-notifications queue');

process.on('SIGTERM', async () => {
  await worker.close();
  logger.info('Worker shut down gracefully');
  process.exit(0);
});
