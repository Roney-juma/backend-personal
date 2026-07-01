const { Queue } = require('bullmq');
const { getRedisClient } = require('./connection');

let notificationQueue = null;
let analyzeQueue = null;

const getQueue = () => {
  const connection = getRedisClient();
  if (!connection) return null;

  if (!notificationQueue) {
    notificationQueue = new Queue('ave-notifications', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
  }

  return notificationQueue;
};

const getAnalyzeQueue = () => {
  const connection = getRedisClient();
  if (!connection) return null;

  if (!analyzeQueue) {
    analyzeQueue = new Queue('claim-analyze', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }

  return analyzeQueue;
};

module.exports = { getQueue, getAnalyzeQueue };
