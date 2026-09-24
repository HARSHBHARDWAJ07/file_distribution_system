const express = require('express');
const { ok } = require('@cloudstore/shared-types');

const app = express();
const PORT = process.env.PORT || 4001;

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

app.listen(PORT, () => {
  console.log(`[auth-service] listening on port ${PORT}`);
});
