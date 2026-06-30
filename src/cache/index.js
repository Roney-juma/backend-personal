const { getRedisClient } = require('../queue/connection');
const logger = require('../middlewheres/logger');

const DEFAULT_TTL = 60;

const get = async (key) => {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    logger.warn(`Cache get failed | key=${key} | ${err.message}`);
    return null;
  }
};

const set = async (key, value, ttl = DEFAULT_TTL) => {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttl);
  } catch (err) {
    logger.warn(`Cache set failed | key=${key} | ${err.message}`);
  }
};

const del = async (...keys) => {
  const client = getRedisClient();
  if (!client) return;
  try {
    if (keys.length) await client.del(...keys);
  } catch (err) {
    logger.warn(`Cache del failed | ${err.message}`);
  }
};

// SCAN-based pattern delete — non-blocking, safe for production
const delPattern = async (pattern) => {
  const client = getRedisClient();
  if (!client) return;
  try {
    let cursor = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = parseInt(next, 10);
      if (keys.length) await client.del(...keys);
    } while (cursor !== 0);
  } catch (err) {
    logger.warn(`Cache delPattern failed | pattern=${pattern} | ${err.message}`);
  }
};

// Cache-aside helper: returns cached value or calls fn(), caches result, returns it
const wrap = async (key, fn, ttl = DEFAULT_TTL) => {
  const cached = await get(key);
  if (cached !== null) return cached;
  const result = await fn();
  if (result !== null && result !== undefined) await set(key, result, ttl);
  return result;
};

module.exports = { get, set, del, delPattern, wrap };
