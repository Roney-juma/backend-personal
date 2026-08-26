// Per-request/per-job context carried implicitly through the async call chain via
// AsyncLocalStorage, so deep code (services, queue enqueues, logger) can read the
// correlation id without it being threaded through every function signature.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Run `fn` with `context` available to everything it (a)synchronously invokes.
const runWithContext = (context, fn) => als.run(context, fn);

// Current correlation id, or undefined when outside any context.
const getCorrelationId = () => als.getStore()?.correlationId;

// Per-request "do this once" guard. Returns true the FIRST time a (bucket, value)
// pair is seen within the current context, false afterwards. Used to de-duplicate
// a notification sent over multiple channels in one request (e.g. an email that
// also mirrors to WhatsApp shouldn't double-send when the flow already sent one).
// With no active context (outside a request/job) it always returns true.
const once = (bucket, value) => {
  const store = als.getStore();
  if (!store) return true;
  const set = store[bucket] || (store[bucket] = new Set());
  if (set.has(value)) return false;
  set.add(value);
  return true;
};

module.exports = { als, runWithContext, getCorrelationId, once };
