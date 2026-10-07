const express = require('express');
const { ok } = require('@cloudstore/shared-types');
const { asyncHandler, requestId, requestLogger, notFound, errorHandler } = require('@cloudstore/http-utils');
const { signup } = require('./routes/signup');
const { login } = require('./routes/login');
const { refresh } = require('./routes/refresh');

// Built separately from listen() so tests can drive it with supertest.
function createApp({ logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // so req.ip in login logs is the client, not the host's proxy

  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '100kb' }));

  app.get('/ping', (req, res) => {
    res.json(ok({
      service: 'auth-service',
      message: 'pong from auth-service',
      timestamp: Date.now(),
    }));
  });

  app.get('/health', (req, res) => {
    res.json(ok({ status: 'healthy' }));
  });

  app.post('/signup', asyncHandler(signup));
  app.post('/login', asyncHandler(login));
  app.post('/refresh', asyncHandler(refresh));

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
