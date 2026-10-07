const express = require('express');
const { ok, errorHandler } = require('@cloudstore/shared-types');
const { httpLogger } = require('@cloudstore/logger');
const { asyncHandler } = require('./lib/asyncHandler');
const { signup } = require('./routes/signup');
const { login } = require('./routes/login');
const { refresh } = require('./routes/refresh');

// Built separately from listen() so tests can drive it with supertest.
function createApp({ logger }) {
  const app = express();

  app.use(httpLogger(logger));
  app.use(express.json({ limit: '16kb' })); // every auth body is a couple of short strings

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

  app.use(errorHandler('auth-service'));
  return app;
}

module.exports = { createApp };
