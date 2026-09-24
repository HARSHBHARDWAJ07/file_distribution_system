const crypto = require('crypto');
const { pool } = require('../lib/db');
const { isRefreshTokenValid, revokeRefreshToken, storeRefreshToken } = require('../lib/redis');
const { signAccessToken } = require('../lib/jwt');
const { ok, fail } = require('@cloudstore/shared-types');

async function refresh(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken || !refreshToken.includes('.')) {
    return res.status(400).json(fail('INVALID_INPUT', 'refreshToken is required'));
  }

  const [userId, tokenId] = refreshToken.split('.');
  const valid = await isRefreshTokenValid(userId, tokenId);
  if (!valid) {
    return res.status(401).json(fail('INVALID_REFRESH_TOKEN', 'refresh token is invalid or has been used'));
  }

  const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json(fail('INVALID_REFRESH_TOKEN', 'user no longer exists'));
  }

  await revokeRefreshToken(userId, tokenId);
  const newTokenId = crypto.randomUUID();
  await storeRefreshToken(userId, newTokenId);

  const accessToken = signAccessToken(user);
  return res.json(ok({ accessToken, refreshToken: `${userId}.${newTokenId}` }));
}

module.exports = { refresh };
