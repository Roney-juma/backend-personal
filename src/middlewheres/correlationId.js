const crypto = require('crypto');
const { runWithContext } = require('../utils/requestContext');

// Assigns a correlation id to every request (reusing an inbound X-Correlation-Id /
// X-Request-Id if the caller or proxy already set one), echoes it on the response, and
// runs the rest of the request inside an AsyncLocalStorage context so all downstream
// logs and enqueued jobs can be traced back to this request.
const correlationId = (req, res, next) => {
  const id =
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID();

  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);

  runWithContext({ correlationId: id }, () => next());
};

module.exports = correlationId;
