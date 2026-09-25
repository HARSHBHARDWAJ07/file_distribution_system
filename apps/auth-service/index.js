const express = require('express');
const { ok, fail } = require('@cloudstore/shared-types');
const { asyncHandler } = require('./lib/asyncHandler');
const { signup } = require('./routes/signup');
const { login } = require('./routes/login');
const { refresh } = require('./routes/refresh');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

app.get('/ping', (req, res) => {
  res.json(ok({
    service: 'auth-service',
    message: 'pong from auth-service',
    timestamp: Date.now()
  }));
});

app.get('/health', (req, res) => {
  res.json(ok({ status: 'healthy' }));
});

app.post('/signup', asyncHandler(signup));
app.post('/login', asyncHandler(login));
app.post('/refresh', asyncHandler(refresh));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[auth-service] unhandled route error:', err);
  res.status(500).json(fail('INTERNAL_ERROR', 'an unexpected error occurred'));
});

app.listen(PORT, () => {
  console.log(`[auth-service] listening on port ${PORT}`);
});
