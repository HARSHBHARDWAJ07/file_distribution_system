const express = require('express');
const cors = require('cors');
const { ok, INTERNAL_TOKEN_HEADER } = require('@cloudstore/shared-types');
const {
  AppError, requestId, requestLogger, notFound, errorHandler, REQUEST_ID_HEADER,
} = require('@cloudstore/http-utils');
const { validateUuid, validatePartNumber } = require('@cloudstore/validation');
const { requireAuth } = require('./middleware/requireAuth');
const { rateLimit, memoryStore } = require('./lib/rateLimit');

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10000;

// Built separately from listen() so tests can drive it with supertest.
function createApp({
  logger,
  authServiceUrl,
  fileServiceUrl,
  jwtSecret,
  internalToken,
  allowedOrigins = [],
  rateLimitStore = memoryStore(),
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  trustProxyHops = 1,
  limits = { auth: 10, api: 100 }, // per minute
}) {
  if (!internalToken) throw new Error('INTERNAL_API_TOKEN must be set');
  const app = express();
  const auth = requireAuth(jwtSecret);

  app.disable('x-powered-by');
  // Behind Render's proxy the client IP is in X-Forwarded-For. Trust exactly
  // the hops in front of us: more and a client can spoof its IP past the
  // limiter; zero and every client shares the proxy's IP and limit.
  app.set('trust proxy', trustProxyHops);

  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(cors({
    origin: allowedOrigins, // exact allow-list; [] means no cross-origin access
    exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }));
  // File bytes never pass through the API, so a large body is always abuse.
  app.use(express.json({ limit: '100kb' }));

  // Credential endpoints: the caller isn't known yet, so limit per IP (slows
  // password guessing and signup spam). Everything else: per user, so one
  // noisy account can't starve others, whatever IPs it uses.
  const authLimiter = rateLimit({
    name: 'auth', limit: limits.auth, windowSeconds: 60, keyFor: req => req.ip, store: rateLimitStore, logger,
  });
  const apiLimiter = rateLimit({
    name: 'api', limit: limits.api, windowSeconds: 60, keyFor: req => req.user.id, store: rateLimitStore, logger,
  });

  // Relays one request upstream and its response back. The proxy builds the
  // upstream headers itself and never copies the client's, so nothing a
  // client sends (x-user-id, x-internal-token) can be smuggled through.
  async function relay(req, res, { serviceName, baseUrl, path, headers = {} }) {
    const url = `${baseUrl}${path}`;
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    let upstream;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: req.id, ...headers },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
    } catch (err) {
      req.log.error({ err, upstream: url }, `${serviceName} request failed`);
      if (err.name === 'TimeoutError') {
        throw new AppError(504, 'UPSTREAM_TIMEOUT', `${serviceName} did not respond in time`);
      }
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', `${serviceName} is unreachable`);
    }

    let data;
    try {
      data = await upstream.json();
    } catch (err) {
      req.log.error({ err, upstream: url, status: upstream.status }, `${serviceName} returned non-JSON`);
      throw new AppError(502, 'UPSTREAM_BAD_RESPONSE', `${serviceName} returned an invalid response`);
    }
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.set('Retry-After', retryAfter);
    return res.status(upstream.status).json(data);
  }

  const route = fn => (req, res, next) => fn(req, res).catch(next);

  const toAuth = path => route((req, res) =>
    relay(req, res, { serviceName: 'auth-service', baseUrl: authServiceUrl, path }));

  // x-user-id is trusted by the file-service only alongside the internal
  // token, and is only ever set here, from the verified JWT.
  const toFiles = pathFor => route((req, res) =>
    relay(req, res, {
      serviceName: 'file-service',
      baseUrl: fileServiceUrl,
      path: pathFor(req.params),
      headers: { 'x-user-id': req.user.id, [INTERNAL_TOKEN_HEADER]: internalToken },
    }));

  // Malformed ids never travel to a service. Validated values are also
  // URL-safe, so an encoded "../" can't redirect the upstream call.
  const checkFileId = (req, res, next) => {
    try { req.params.fileId = validateUuid(req.params.fileId, 'fileId'); next(); } catch (err) { next(err); }
  };
  const checkPart = (req, res, next) => {
    try { req.params.partNumber = validatePartNumber(req.params.partNumber); next(); } catch (err) { next(err); }
  };

  app.get('/health', (req, res) => {
    res.json(ok({ status: 'gateway healthy' }));
  });

  app.get('/api/auth/ping', toAuth('/ping'));
  app.post('/api/auth/signup', authLimiter, toAuth('/signup'));
  app.post('/api/auth/login', authLimiter, toAuth('/login'));
  app.post('/api/auth/refresh', authLimiter, toAuth('/refresh'));

  const user = [auth, apiLimiter];
  app.get('/api/me', user, (req, res) => {
    res.json(ok({ user: req.user }));
  });

  app.post('/api/files/uploads/init', user, toFiles(() => '/uploads/init'));
  app.get('/api/files/uploads/:fileId/status', user, checkFileId, toFiles(p => `/uploads/${p.fileId}/status`));
  app.get('/api/files/uploads/:fileId/parts/:partNumber', user, checkFileId, checkPart,
    toFiles(p => `/uploads/${p.fileId}/parts/${p.partNumber}`));
  app.post('/api/files/uploads/:fileId/parts/:partNumber', user, checkFileId, checkPart,
    toFiles(p => `/uploads/${p.fileId}/parts/${p.partNumber}`));
  app.post('/api/files/uploads/:fileId/complete', user, checkFileId, toFiles(p => `/uploads/${p.fileId}/complete`));
  app.post('/api/files/uploads/:fileId/abort', user, checkFileId, toFiles(p => `/uploads/${p.fileId}/abort`));
  app.get('/api/files/:fileId/download', user, checkFileId, toFiles(p => `/files/${p.fileId}/download`));
  app.delete('/api/files/:fileId', user, checkFileId, toFiles(p => `/files/${p.fileId}`));

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
