const express = require('express');
const { ok, fail } = require('@cloudstore/shared-types');
const { requireAuth } = require('./middleware/requireAuth');

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';

app.use(express.json());

async function forward(path, req, res) {
  try {
    const upstream = await fetch(`${AUTH_SERVICE_URL}${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json(fail('UPSTREAM_UNREACHABLE', 'auth-service did not respond'));
  }
}

app.get('/api/auth/ping', (req, res) => forward('/ping', req, res));
app.post('/api/auth/signup', (req, res) => forward('/signup', req, res));
app.post('/api/auth/login', (req, res) => forward('/login', req, res));
app.post('/api/auth/refresh', (req, res) => forward('/refresh', req, res));

// Every future service route (file, metadata) sits behind this same middleware.
app.get('/api/me', requireAuth, (req, res) => {
  res.json(ok({ user: req.user }));
});

app.get('/health', (req, res) => {
  res.json(ok({ status: 'gateway healthy' }));
});

app.listen(PORT, () => {
  console.log(`[gateway] listening on port ${PORT}`);
});
