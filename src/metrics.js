const http = require('http');
const client = require('prom-client');
const logger = require('./middlewheres/logger');

// Per-process metrics registry. Under PM2 CLUSTER mode each worker is its own
// process with its own registry; we expose each worker on its own port and let
// Prometheus scrape them as separate targets. (prom-client's AggregatorRegistry
// can't reach the workers because the cluster master is PM2's daemon, not our
// code — so per-worker scraping is the reliable pattern.)
const register = new client.Registry();

// PM2 sets NODE_APP_INSTANCE to 0,1,2… per cluster worker (0 for fork/non-PM2).
const instance = process.env.NODE_APP_INSTANCE || '0';

// Labels attached to every metric so Grafana can sum across workers or break the
// data down by individual worker.
register.setDefaultLabels({ app: 'ave-backend', worker: instance });

// Node runtime metrics: event-loop lag, heap, GC pauses, CPU, open handles, etc.
client.collectDefaultMetrics({ register });

// ── Custom HTTP metrics ─────────────────────────────────────────────────────
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  // Tuned for a typical API: sub-10ms to slow 5s requests.
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register],
});

// Paths that shouldn't be counted as application traffic.
const SKIP_PATHS = new Set(['/health', '/ready', '/metrics', '/favicon.ico']);

// Express middleware: times each request and records method/route/status. Mount
// it early so it wraps the whole chain; the route label is read on 'finish',
// by which point Express has populated req.route.
function metricsMiddleware(req, res, next) {
  if (SKIP_PATHS.has(req.path)) return next();
  httpRequestsInFlight.inc();
  const endTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    httpRequestsInFlight.dec();
    // Use the MATCHED route pattern (e.g. /users/:id) rather than the raw URL so
    // ids don't explode label cardinality. Unmatched requests share one bucket.
    const route = req.route
      ? (req.baseUrl || '') + req.route.path
      : (req.baseUrl || 'unmatched');
    endTimer({ method: req.method, route, status_code: res.statusCode });
  });
  next();
}

// Dedicated metrics HTTP server, bound to LOOPBACK so /metrics is never exposed
// on the public API. One port per process: portBase + worker index. The web app
// uses the default base (9464 → 9464/9465 for its cluster workers); the worker
// passes a distinct base (9470) so its port never collides with the app's.
function startMetricsServer(portBase) {
  const base = Number(portBase) || Number(process.env.METRICS_PORT_BASE) || 9464;
  const port = base + Number(instance);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end(err.message);
      }
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  server.on('error', (err) => logger.error(`[metrics] server error on :${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => {
    logger.info(`[metrics] worker ${instance} exposing /metrics on 127.0.0.1:${port}`);
  });
  return server;
}

module.exports = { register, metricsMiddleware, startMetricsServer };
