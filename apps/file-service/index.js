const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('./app');

const logger = createLogger('file-service');
const PORT = process.env.PORT || 4002;

const app = createApp({ logger, internalToken: process.env.INTERNAL_API_TOKEN });

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'file-service listening');
});
