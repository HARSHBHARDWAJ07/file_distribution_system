const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function refreshKey(userId, tokenId) { return `refresh:${userId}:${tokenId}`; }

async function storeRefreshToken(userId, tokenId) {
  await redis.set(refreshKey(userId, tokenId), '1', 'EX', REFRESH_TTL_SECONDS);
}

async function isRefreshTokenValid(userId, tokenId) {
  return (await redis.get(refreshKey(userId, tokenId))) === '1';
}

async function revokeRefreshToken(userId, tokenId) {
  await redis.del(refreshKey(userId, tokenId));
}

module.exports = { redis, storeRefreshToken, isRefreshTokenValid, revokeRefreshToken };
