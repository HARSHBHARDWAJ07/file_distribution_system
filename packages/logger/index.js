// Structured JSON logging shared by every service: one line per event, with
// `service` on every line and credentials redacted in one place. Request
// logging (with request ids) lives in @cloudstore/http-utils.
const pino = require('pino');

// Never let credentials reach a log line, whatever object gets logged.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-internal-token"]',
  'req.headers.cookie',
  'authorization',
  'password', '*.password',
  'refreshToken', '*.refreshToken',
  'accessToken', '*.accessToken',
  'uploadUrl', '*.uploadUrl', 'downloadUrl', '*.downloadUrl', // presigned URLs are bearer credentials
];

function createLogger(service) {
  return pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };
