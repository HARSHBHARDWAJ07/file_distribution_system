const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('./app');

const logger = createLogger('auth-service');
const PORT = process.env.PORT || 4001;

// Without it every token would be signed with "undefined" - fail at boot instead.
if (!process.env.JWT_SECRET) {
  logger.fatal('JWT_SECRET must be set');
  process.exit(1);
}

const app = createApp({ logger });

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'auth-service listening');
});
