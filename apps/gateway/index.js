const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('./app');

const logger = createLogger('gateway');
const PORT = process.env.PORT || 4000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';
const FILE_SERVICE_URL = process.env.FILE_SERVICE_URL || 'http://localhost:4002';

const app = createApp({
  logger,
  authServiceUrl: AUTH_SERVICE_URL,
  fileServiceUrl: FILE_SERVICE_URL,
  jwtSecret: process.env.JWT_SECRET,
  internalToken: process.env.INTERNAL_API_TOKEN,
});

app.listen(PORT, () => {
  logger.info({ port: PORT, authServiceUrl: AUTH_SERVICE_URL, fileServiceUrl: FILE_SERVICE_URL }, 'gateway listening');
});
