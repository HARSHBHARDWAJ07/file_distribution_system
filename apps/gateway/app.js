const express = require('express');
const { ok, fail, errorHandler, INTERNAL_TOKEN_HEADER } = require('@cloudstore/shared-types');
const { httpLogger, REQUEST_ID_HEADER } = require('@cloudstore/logger');
const { requireAuth } = require('./middleware/requireAuth');

// Free-tier upstreams can take ~30-50s to wake from sleep; past this, give up.
const UPSTREAM_TIMEOUT_MS = 60000;

// Built separately from listen() so tests can drive it with supertest.
function createApp({ logger, authServiceUrl, fileServiceUrl, jwtSecret, internalToken }) {
  if (!internalToken) throw new Error('INTERNAL_API_TOKEN must be set');
  const app = express();
  const auth = requireAuth(jwtSecret);

  app.use(httpLogger(logger));
  app.use(express.json({ limit: '1mb' }));

  // Relays one request upstream and its response back. Upstream outages and
  // non-JSON replies (e.g. a host's HTML error page) become 502 envelopes.
  async function relay(req, res, { serviceName, baseUrl, path, headers = {} }) {
    const url = `${baseUrl}${path}`;
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    let upstream;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: req.id, ...headers },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      req.log.error({ err, upstream: url }, `${serviceName} unreachable`);
      return res.status(502).json(fail('UPSTREAM_UNREACHABLE', `${serviceName} did not respond`));
    }

    let data;
    try {
      data = await upstream.json();
    } catch (err) {
      req.log.error({ err, upstream: url, status: upstream.status }, `${serviceName} returned non-JSON`);
      return res.status(502).json(fail('UPSTREAM_BAD_RESPONSE', `${serviceName} returned an invalid response`));
    }
    return res.status(upstream.status).json(data);
  }

  const toAuth = path => (req, res) =>
    relay(req, res, { serviceName: 'auth-service', baseUrl: authServiceUrl, path });

  // x-user-id is trusted by the file-service only alongside the internal
  // token, and it is only ever set here, after the JWT has been verified.
  const toFiles = pathFor => (req, res) =>
    relay(req, res, {
      serviceName: 'file-service',
      baseUrl: fileServiceUrl,
      path: pathFor(req.params),
      headers: { 'x-user-id': req.user.id, [INTERNAL_TOKEN_HEADER]: internalToken },
    });

  // Path params are URL-encoded before being put into an upstream path, so a
  // crafted id like "x/../../other" can't redirect the call to another route.
  const enc = encodeURIComponent;

  app.get('/api/auth/ping', toAuth('/ping'));
  app.post('/api/auth/signup', toAuth('/signup'));
  app.post('/api/auth/login', toAuth('/login'));
  app.post('/api/auth/refresh', toAuth('/refresh'));

  app.get('/api/me', auth, (req, res) => {
    res.json(ok({ user: req.user }));
  });

  app.post('/api/files/uploads/init', auth, toFiles(() => '/uploads/init'));
  app.get('/api/files/uploads/:fileId/status', auth, toFiles(p => `/uploads/${enc(p.fileId)}/status`));
  app.get('/api/files/uploads/:fileId/parts/:partNumber', auth,
    toFiles(p => `/uploads/${enc(p.fileId)}/parts/${enc(p.partNumber)}`));
  app.post('/api/files/uploads/:fileId/parts/:partNumber', auth,
    toFiles(p => `/uploads/${enc(p.fileId)}/parts/${enc(p.partNumber)}`));
  app.post('/api/files/uploads/:fileId/complete', auth, toFiles(p => `/uploads/${enc(p.fileId)}/complete`));
  app.get('/api/files/:fileId/download', auth, toFiles(p => `/files/${enc(p.fileId)}/download`));
  app.delete('/api/files/:fileId', auth, toFiles(p => `/files/${enc(p.fileId)}`));

  app.get('/health', (req, res) => {
    res.json(ok({ status: 'gateway healthy' }));
  });

  app.use((req, res) => res.status(404).json(fail('NOT_FOUND', 'no such route')));
  app.use(errorHandler('gateway'));
  return app;
}

module.exports = { createApp };
