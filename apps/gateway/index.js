const express = require('express');
const { ok, fail } = require('@cloudstore/shared-types');
const { requireAuth } = require('./middleware/requireAuth');

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';
const FILE_SERVICE_URL = process.env.FILE_SERVICE_URL || 'http://localhost:4002';

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
    console.error(`[gateway] forward to auth-service (${AUTH_SERVICE_URL}${path}) failed:`, err);
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

async function forwardFile(path, req, res) {
  try {
    const upstream = await fetch(`${FILE_SERVICE_URL}${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'x-user-id': req.user.id },
      body: ['GET', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error(`[gateway] forward to file-service (${FILE_SERVICE_URL}${path}) failed:`, err);
    res.status(502).json(fail('UPSTREAM_UNREACHABLE', 'file-service did not respond'));
  }
}

app.post('/api/files/uploads/init', requireAuth, (req, res) => forwardFile('/uploads/init', req, res));
app.get('/api/files/uploads/:fileId/status', requireAuth, (req, res) =>
  forwardFile(`/uploads/${req.params.fileId}/status`, req, res));
app.get('/api/files/uploads/:fileId/parts/:partNumber', requireAuth, (req, res) =>
  forwardFile(`/uploads/${req.params.fileId}/parts/${req.params.partNumber}`, req, res));
app.post('/api/files/uploads/:fileId/parts/:partNumber', requireAuth, (req, res) =>
  forwardFile(`/uploads/${req.params.fileId}/parts/${req.params.partNumber}`, req, res));
app.post('/api/files/uploads/:fileId/complete', requireAuth, (req, res) =>
  forwardFile(`/uploads/${req.params.fileId}/complete`, req, res));
app.get('/api/files/:fileId/download', requireAuth, (req, res) =>
  forwardFile(`/files/${req.params.fileId}/download`, req, res));
app.delete('/api/files/:fileId', requireAuth, (req, res) =>
  forwardFile(`/files/${req.params.fileId}`, req, res));

app.get('/health', (req, res) => {
  res.json(ok({ status: 'gateway healthy' }));
});

app.listen(PORT, () => {
  console.log(`[gateway] listening on port ${PORT}`);
  console.log(`[gateway] AUTH_SERVICE_URL=${AUTH_SERVICE_URL}`);
  console.log(`[gateway] FILE_SERVICE_URL=${FILE_SERVICE_URL}`);
});
