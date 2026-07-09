require("dotenv").config();
const express = require("express");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const router = require("./routes/index");
const logger = require('./middlewheres/logger');
const httpLogger = require('./middlewheres/httpLogger');
const mongoose = require("mongoose");
const cors = require("cors");
const { corsOptions } = require('./config/cors');
const sanitizeRequest = require('./middlewheres/sanitizeRequest');
const correlationId = require('./middlewheres/correlationId');
const { getRedisClient } = require('./queue/connection');
const socketModule = require('./socket');

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('Connected to MongoDB'))
  .catch((err) => logger.error('MongoDB connection error:', err));

const app = express();
// Trust the reverse proxy (nginx) so rate-limit / logging see the real client IP.
app.set('trust proxy', 1);

// Correlation id first, so health checks and every downstream log carry a trace id.
app.use(correlationId);

// ── Probes (before rate-limiting/logging so they aren't throttled or noisy) ──────
// Liveness: the process is up. Never touches dependencies.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: safe to receive traffic. Mongo is required; Redis is best-effort
// (the app degrades to direct sends without it), so it's reported but not fatal.
app.get('/ready', async (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;

  let redis = 'not_configured';
  if (process.env.REDIS_URL) {
    try {
      const client = getRedisClient();
      redis = client && (await client.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      redis = 'down';
    }
  }

  const ready = mongoConnected;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    mongo: mongoConnected ? 'up' : 'down',
    redis,
  });
});

// Global rate limiter — caps requests per IP. Tune via RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX.
const globalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

app.use(helmet());                          // security headers
app.use(cors(corsOptions));                 // restricted CORS (env allowlist)
app.use(express.json({ limit: '10mb' }));   // parse + cap JSON body size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(globalLimiter);                     // rate limiting
app.use(sanitizeRequest);                   // WAF-lite input sanitizer
app.use(httpLogger);
app.use("/", router);

app.get("/v1", (req, res) => {
  res.send("New phase of AVEAFRICA SOLUTIONS");
});

app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ message: 'Internal server error' });
});

const server = http.createServer(app);
socketModule.init(server);

server.listen(PORT, (error) => {
  if (error) {
    logger.error('Server failed to start:', error);
  } else {
    logger.info(`Server running on port ${PORT}`);
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
const shutdown = (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — shutting down gracefully`);

  // Stop accepting new connections, then close dependencies.
  server.close(async () => {
    try {
      try { socketModule.getIO().close(); } catch { /* not initialized */ }
      await mongoose.connection.close(false);
      const redis = getRedisClient();
      if (redis) await redis.quit();
    } catch (err) {
      logger.error(`Error during shutdown: ${err.message}`);
    }
    logger.info('Shutdown complete');
    process.exit(exitCode);
  });

  // Don't hang forever on lingering (keep-alive) connections.
  setTimeout(() => {
    logger.error('Forced shutdown after 10s timeout');
    process.exit(exitCode || 1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Crash handlers — an uncaught exception leaves the process in an unknown state, so log
// and shut down (exit 1) to let the supervisor (PM2) restart cleanly.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled rejection: ${err.message}`, { stack: err.stack });
});

module.exports = app;
