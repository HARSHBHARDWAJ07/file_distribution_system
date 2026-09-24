const express = require('express');
const { ok } = require('@cloudstore/shared-types');
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

app.post('/signup', signup);
app.post('/login', login);
app.post('/refresh', refresh);

app.listen(PORT, () => {
  console.log(`[auth-service] listening on port ${PORT}`);
});
