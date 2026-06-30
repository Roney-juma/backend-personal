const { Redis } = require('ioredis');
const logger = require('../middlewheres/logger');

let client = null;

const getRedisClient = () => {
  if (!process.env.REDIS_URL) return null;
  if (client) return client;

  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
  client.on('connect', () => logger.info('Redis connected'));

  return client;
};

module.exports = { getRedisClient };
