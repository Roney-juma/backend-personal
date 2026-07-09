const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { getCorrelationId } = require('../utils/requestContext');

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

// Pull the current correlation id (if any) off the async context onto every log record,
// so requests and their queued jobs can be traced without passing the id around.
const withCorrelationId = winston.format((info) => {
  const cid = getCorrelationId();
  if (cid) info.correlationId = cid;
  return info;
});

const devFormat = combine(
  withCorrelationId(),
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, correlationId }) => {
    const cid = correlationId ? ` [${correlationId}]` : '';
    return stack ? `${ts}${cid} ${level}: ${message}\n${stack}` : `${ts}${cid} ${level}: ${message}`;
  })
);

const prodFormat = combine(
  withCorrelationId(),
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console({ stderrLevels: ['error'] }),
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
  ],
});

module.exports = logger;
