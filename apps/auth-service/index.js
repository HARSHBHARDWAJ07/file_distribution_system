const { createLogger } = require('@cloudstore/logger');
const { requireEnv, logProcessErrors } = require('@cloudstore/http-utils');

const logger = createLogger('auth-service');
logProcessErrors(logger);
// Without JWT_SECRET every token would be signed with "undefined".
requireEnv(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET']);

const { createApp } = require('./app');
const PORT = process.env.PORT || 4001;

const app = createApp({ logger });

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'auth-service listening');
});
