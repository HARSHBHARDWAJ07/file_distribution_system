// HTTP plumbing every service shares, so every service fails the same way.
// Wire it in this order: requestId -> requestLogger -> express.json -> routes
// -> notFound -> errorHandler (the id must exist before anything logs, and
// the error handler must come last).
const crypto = require('crypto');
const pinoHttp = require('pino-http');
const { fail } = require('@cloudstore/shared-types');

// An error the client is allowed to see: an expected failure (400, 404, 409,
// 429...) with a code it can act on. Anything that isn't an AppError is a bug
// and is reported as a generic 500.
class AppError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.headers = headers; // e.g. Retry-After on a 429
  }
}

// Express 4 ignores a rejected promise from a route; this forwards it to the
// error handler instead of leaving the request hanging.
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const REQUEST_ID_HEADER = 'x-request-id';
// Strict on purpose: the id is written into log lines, so anything that could
// smuggle a newline or fake JSON into a log is replaced with a fresh UUID.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function requestId() {
  return (req, res, next) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    req.id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader(REQUEST_ID_HEADER, req.id);
    next();
  };
}

// The path only: query strings can carry tokens, and presigned-URL style
// parameters are bearer credentials.
const pathOf = req => (req.originalUrl || req.url || '').split('?')[0];

// One JSON line per finished request: method, path, status, duration, user.
// Level follows status, so alerting can key on `error` (5xx) alone.
function requestLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: req => req.id,
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
    // ip is the client as Express resolves it through `trust proxy`, so logs
    // also show whether the proxy-hop setting matches the real deployment.
    customProps: req => ({ userId: req.user?.id || req.userId, ip: req.ip }),
    autoLogging: { ignore: req => pathOf(req) === '/health' },
    serializers: {
      req: req => ({ id: req.id, method: req.method, path: pathOf(req.raw || req) }),
      res: res => ({ statusCode: res.statusCode }),
    },
  });
}

function notFound() {
  return (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'no such route'));
}

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'something went wrong on our side';
    if (err instanceof AppError) {
      ({ status, code, message } = err);
      if (err.headers) res.set(err.headers);
    } else if (err.type === 'entity.parse.failed') {
      status = 400; code = 'INVALID_JSON'; message = 'request body is not valid JSON';
    } else if (err.type === 'entity.too.large') {
      status = 413; code = 'BODY_TOO_LARGE'; message = 'request body is too large';
    } else {
      // Full detail (stack, SQL error) stays in the logs; the client gets the id.
      (req.log || logger).error({ err, requestId: req.id }, 'unhandled error');
    }

    const body = fail(code, message);
    body.error.requestId = req.id; // the user quotes this; you grep the exact log line
    res.status(status).json(body);
  };
}

// Fail at boot, listing everything missing, instead of cryptically per request
// (a missing JWT_SECRET otherwise shows up as "invalid token" for everyone).
function requireEnv(names) {
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error(`missing required environment variable(s): ${missing.join(', ')}`);
  }
}

// A stray rejection is a bug worth seeing; an uncaught exception leaves the
// process in an unknown state, so log it and exit for the host to restart.
function logProcessErrors(logger) {
  process.on('unhandledRejection', err => logger.error({ err }, 'unhandled promise rejection'));
  process.on('uncaughtException', err => {
    logger.fatal({ err }, 'uncaught exception, exiting');
    process.exit(1);
  });
}

module.exports = {
  AppError,
  asyncHandler,
  requestId,
  requestLogger,
  notFound,
  errorHandler,
  requireEnv,
  logProcessErrors,
  REQUEST_ID_HEADER,
};
