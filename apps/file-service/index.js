const { createLogger } = require('@cloudstore/logger');
const { requireEnv, logProcessErrors } = require('@cloudstore/http-utils');

const logger = createLogger('file-service');
logProcessErrors(logger);
requireEnv([
  'DATABASE_URL',
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'INTERNAL_API_TOKEN',
]);

const { createApp } = require('./app');
const PORT = process.env.PORT || 4002;

const app = createApp({ logger, internalToken: process.env.INTERNAL_API_TOKEN });

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'file-service listening');
});
