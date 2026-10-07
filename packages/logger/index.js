// Structured JSON logging shared by every service. One line per event, with
// `service` and (for HTTP) `reqId` on every line, so logs from the gateway and
// the service it called can be joined on the same request id.
const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');

const REQUEST_ID_HEADER = 'x-request-id';

// Never let credentials reach a log line, whatever object gets logged.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-internal-token"]',
  'req.headers.cookie',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
];

function createLogger(service) {
  return pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

// Request id: reuse the caller's (the gateway forwards it) or mint one, and
// echo it back so a client can quote it in a bug report.
function httpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId(req, res) {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: { ignore: req => req.url === '/health' },
    serializers: {
      req: req => ({ id: req.id, method: req.method, url: req.url }),
      res: res => ({ statusCode: res.statusCode }),
    },
  });
}

module.exports = { createLogger, httpLogger, REQUEST_ID_HEADER };
