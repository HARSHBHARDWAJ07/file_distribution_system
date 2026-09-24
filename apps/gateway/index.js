const express = require('express');
const { ok, fail } = require('@cloudstore/shared-types');

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';

app.get('/api/auth/ping', async (req, res) => {
  try {
    const upstream = await fetch(`${AUTH_SERVICE_URL}/ping`);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json(fail('UPSTREAM_UNREACHABLE', 'auth-service did not respond'));
  }
});

app.get('/health', (req, res) => {
  res.json(ok({ status: 'gateway healthy' }));
});

app.listen(PORT, () => {
  console.log(`[gateway] listening on port ${PORT}`);
});
