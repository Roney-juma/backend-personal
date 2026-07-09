// Per-request/per-job context carried implicitly through the async call chain via
// AsyncLocalStorage, so deep code (services, queue enqueues, logger) can read the
// correlation id without it being threaded through every function signature.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Run `fn` with `context` available to everything it (a)synchronously invokes.
const runWithContext = (context, fn) => als.run(context, fn);

// Current correlation id, or undefined when outside any context.
const getCorrelationId = () => als.getStore()?.correlationId;

module.exports = { als, runWithContext, getCorrelationId };
