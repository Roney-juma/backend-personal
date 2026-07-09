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
const socketModule = require('./socket');

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('Connected to MongoDB'))
  .catch((err) => logger.error('MongoDB connection error:', err));

const app = express();
// Trust the reverse proxy (nginx) so rate-limit / logging see the real client IP.
app.set('trust proxy', 1);

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

module.exports = app;
