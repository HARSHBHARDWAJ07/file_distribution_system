const { createLogger } = require('@cloudstore/logger');
const { requireEnv, logProcessErrors } = require('@cloudstore/http-utils');

const logger = createLogger('gateway');
logProcessErrors(logger);
requireEnv(['JWT_SECRET', 'INTERNAL_API_TOKEN', 'AUTH_SERVICE_URL', 'FILE_SERVICE_URL']);

const Redis = require('ioredis');
const { createApp } = require('./app');
const { memoryStore, redisStore } = require('./lib/rateLimit');

const PORT = process.env.PORT || 4000;

// Rate-limit counters live in Redis so every gateway instance shares them.
// Commands fail fast instead of queueing while Redis is down, so the limiter
// can fail open immediately rather than hang requests.
let rateLimitStore;
if (process.env.REDIS_URL) {
  const redis = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  redis.on('error', err => logger.warn({ err: err.message }, 'redis error (rate limiter fails open)'));
  rateLimitStore = redisStore(redis);
} else {
  logger.warn('REDIS_URL not set: rate limits are per-process, correct only for a single gateway instance');
  rateLimitStore = memoryStore();
}

const app = createApp({
  logger,
  authServiceUrl: process.env.AUTH_SERVICE_URL,
  fileServiceUrl: process.env.FILE_SERVICE_URL,
  jwtSecret: process.env.JWT_SECRET,
  internalToken: process.env.INTERNAL_API_TOKEN,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  rateLimitStore,
  // Free-tier upstreams can take ~25s to wake from sleep; production raises this.
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS) || undefined,
  trustProxyHops: process.env.TRUST_PROXY_HOPS === undefined ? 1 : Number(process.env.TRUST_PROXY_HOPS),
});

app.listen(PORT, () => {
  logger.info({
    port: PORT,
    authServiceUrl: process.env.AUTH_SERVICE_URL,
    fileServiceUrl: process.env.FILE_SERVICE_URL,
  }, 'gateway listening');
});
