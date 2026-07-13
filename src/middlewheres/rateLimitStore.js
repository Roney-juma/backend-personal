const { getRedisClient } = require('../queue/connection');
const logger = require('./logger');

/**
 * Returns a rate-limit store backed by the shared Redis client, so limits are
 * enforced GLOBALLY across every app instance. Without this, express-rate-limit
 * keeps counters in each process's memory — so with N instances a client gets N×
 * the intended allowance and brute-force protection is effectively divided by N.
 *
 * Falls back to `undefined` (in-memory store) when Redis isn't configured, which
 * keeps single-instance / local dev working unchanged.
 *
 * @param {string} prefix - key namespace, e.g. 'rl:global:' or 'rl:auth:'
 */
const makeRedisStore = (prefix) => {
  const client = getRedisClient();
  if (!client) return undefined;

  try {
    const { RedisStore } = require('rate-limit-redis');
    return new RedisStore({
      // ioredis: client.call(cmd, ...args) is the generic command sender.
      sendCommand: (...args) => client.call(...args),
      prefix,
    });
  } catch (err) {
    logger.warn(`[rate-limit] Redis store unavailable, using in-memory: ${err.message}`);
    return undefined;
  }
};

module.exports = { makeRedisStore };
